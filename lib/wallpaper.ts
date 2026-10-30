import app from "$lib/app"
import { createState } from "ags"
import { run_command } from "$lib/commands"
import { debounce, interval, type timer } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"

import env from "$lib/env"
import {
	attempt,
	err,
	log_error,
	ok,
	with_context,
	type result,
} from "$lib/result"
import {
	ensure_directory,
	max_image_bytes,
	query_file_signature,
	valid_image_dimensions,
	file_size,
} from "$lib/files"

export const wallpaper_path = `${env.paths.home}/.config/background`
const preview_prefix = `${env.paths.cache.base}/wallpaper-preview`
const validation_size = 256
const [wallpaper_revision, set_wallpaper_revision] = createState(0)
export { wallpaper_revision }
const [wallpaper_preview, set_wallpaper_preview] = createState<string | null>(
	null,
)
export { wallpaper_preview }

let generation = 0
let signature: string | null = null
let signature_error: string | null = null
let monitor: Gio.FileMonitor | null = null
let poll_timer: timer | null = null

function needs_polling() {
	if (!monitor) return true
	return GLib.file_test(wallpaper_path, GLib.FileTest.IS_SYMLINK)
}

function update_polling() {
	if (!needs_polling()) {
		poll_timer?.cancel()
		poll_timer = null
		return
	}
	if (!poll_timer) poll_timer = interval(1000, refresh)
}

function refresh() {
	refresh_wallpaper.call()
	update_polling()
}

function read_signature(): string | null {
	const found = query_file_signature(wallpaper_path)
	if (found.ok) {
		signature_error = null
		return found.value?.value ?? null
	}
	const message = String(found.err)
	if (signature_error !== message)
		console.error("wallpaper: Failed to inspect wallpaper", found.err)
	signature_error = message
	return signature
}

signature = read_signature()
const refresh_wallpaper = debounce(75, () => {
	const next = read_signature()
	if (next === signature) return
	signature = next
	set_wallpaper_revision((revision) => revision + 1)
})

function names_wallpaper(file: Gio.File, other: Gio.File | null) {
	if (file.get_path() === wallpaper_path) return true
	return other?.get_path() === wallpaper_path
}

function watch_wallpaper_directory(): Gio.FileMonitor | null {
	const watched = attempt(() =>
		Gio.File.new_for_path(
			GLib.path_get_dirname(wallpaper_path),
		).monitor_directory(Gio.FileMonitorFlags.NONE, null),
	)
	if (!watched.ok) {
		console.error(
			"wallpaper: Failed to monitor wallpaper directory",
			watched.err,
		)
		return null
	}
	watched.value.connect("changed", (_monitor, file, other) => {
		if (names_wallpaper(file, other)) refresh()
	})
	return watched.value
}

monitor = watch_wallpaper_directory()
update_polling()

app.connect("shutdown", () => {
	generation++
	refresh_wallpaper.cancel()
	poll_timer?.cancel()
	monitor?.cancel()
	monitor = null
})

type image_info = [GdkPixbuf.PixbufFormat | null, number, number]

function confirmed(done: result<boolean>, message: string): result<void> {
	if (!done.ok) return done
	if (!done.value) return err(new Error(message))
	return ok(undefined)
}

function check_image_size(path: string): result<void> {
	const size = file_size(path)
	if (!size.ok) return size
	if (size.value <= 0 || size.value > max_image_bytes)
		return err(
			new Error(
				`Wallpaper must be nonempty and no larger than ${max_image_bytes} bytes`,
			),
		)
	return ok(undefined)
}

function start_async<T>(
	start: (finish: (finished: result<T>) => void) => void,
): Promise<result<T>> {
	return new Promise((resolve) => {
		const started = attempt(() => start(resolve))
		if (!started.ok) resolve(started)
	})
}

function read_image_info(path: string) {
	return start_async<image_info>((finish) =>
		GdkPixbuf.Pixbuf.get_file_info_async(path, null, (_source, result) =>
			finish(attempt(() => GdkPixbuf.Pixbuf.get_file_info_finish(result))),
		),
	)
}

function open_stream(path: string) {
	const file = Gio.File.new_for_path(path)
	return start_async<Gio.FileInputStream>((finish) =>
		file.read_async(GLib.PRIORITY_DEFAULT, null, (_source, result) =>
			finish(attempt(() => file.read_finish(result))),
		),
	)
}

function decode_scaled(stream: Gio.InputStream, size: number) {
	return start_async<GdkPixbuf.Pixbuf>((finish) =>
		GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
			stream,
			size,
			size,
			true,
			null,
			(_source, result) => {
				const image = attempt(() =>
					GdkPixbuf.Pixbuf.new_from_stream_finish(result),
				)
				if (image.ok && !image.value)
					finish(err(new Error("Wallpaper decoder returned no image")))
				else finish(image)
			},
		),
	)
}

function close_stream(
	stream: Gio.InputStream | Gio.OutputStream,
): result<void> {
	const closed = attempt(() => stream.close(null))
	if (closed.ok && closed.value) return ok(undefined)
	return err(
		new Error("Failed to close wallpaper stream", {
			cause: closed.ok ? undefined : closed.err,
		}),
	)
}

async function decode_image(
	path: string,
	size: number,
): Promise<result<GdkPixbuf.Pixbuf>> {
	const bytes = check_image_size(path)
	if (!bytes.ok) return bytes
	const info = await read_image_info(path)
	if (!info.ok) return info
	const [format, width, height] = info.value
	if (!format || !valid_image_dimensions(width, height))
		return err(new Error("Wallpaper format or dimensions are unsupported"))
	const stream = await open_stream(path)
	if (!stream.ok) return stream
	const target = Math.min(size, Math.max(width, height))
	const decoded = await decode_scaled(stream.value, target)
	const closed = close_stream(stream.value)
	if (closed.ok) return decoded
	log_error(decoded, "wallpaper.decode: Failed to decode wallpaper")
	return closed
}

function remove_file(file: Gio.File): result<void> {
	return confirmed(
		attempt(() => file.delete(null)),
		"Temporary wallpaper was not removed",
	)
}

function discard_staged(staged: Gio.File, outcome: result<void>): result<void> {
	const removed = remove_file(staged)
	if (removed.ok) return outcome
	if (outcome.ok)
		return with_context(removed, "Failed to remove temporary wallpaper")
	console.error(
		"wallpaper.set: Failed to remove temporary wallpaper",
		removed.err,
	)
	return outcome
}

function commit_staged(
	staged: Gio.File,
	destination: Gio.File,
	ready: result<void>,
): result<void> {
	if (!ready.ok) return discard_staged(staged, ready)
	const moved = confirmed(
		attempt(() =>
			staged.move(destination, Gio.FileCopyFlags.OVERWRITE, null, null),
		),
		"Failed to replace wallpaper",
	)
	if (!moved.ok) return discard_staged(staged, moved)
	return moved
}

let preview_building = false
let preview_wanted = 0
const preview_file = /^wallpaper-preview(-[0-9a-f]{40}-\d+\.png|\.png|\.json)$/
const preview_staged =
	/^wallpaper-preview(-[0-9a-f]{40}-\d+)?\.png\.[0-9a-f-]+$/

function list_previews(): result<string[]> {
	return attempt(() => {
		const enumerator = Gio.File.new_for_path(
			env.paths.cache.base,
		).enumerate_children(
			"standard::name",
			Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
			null,
		)
		const found: string[] = []
		let info = enumerator.next_file(null)
		while (info) {
			const name = info.get_name()
			const staged = !preview_building && preview_staged.test(name)
			if (staged || preview_file.test(name))
				found.push(`${env.paths.cache.base}/${name}`)
			info = enumerator.next_file(null)
		}
		enumerator.close(null)
		return found
	})
}

function drop_previews(keep: string | null) {
	const previews = list_previews()
	if (!log_error(previews, "wallpaper.preview: Failed to list previews")) return
	for (const path of previews.value) {
		if (path === keep) continue
		log_error(
			remove_file(Gio.File.new_for_path(path)),
			"wallpaper.preview: Failed to drop cached preview",
		)
	}
}

async function save_preview(
	path: string,
	size: number,
	current: () => boolean,
): Promise<result<void>> {
	const image = await decode_image(wallpaper_path, size)
	if (!current()) return ok(undefined)
	if (!image.ok) return image
	const staged = Gio.File.new_for_path(`${path}.${GLib.uuid_string_random()}`)
	const stream = attempt(() => staged.create(Gio.FileCreateFlags.PRIVATE, null))
	if (!stream.ok) return stream
	const encoded = await start_async<boolean>((finish) =>
		image.value.save_to_streamv_async(
			stream.value,
			"png",
			[],
			[],
			null,
			(_source, result) =>
				finish(attempt(() => GdkPixbuf.Pixbuf.save_to_stream_finish(result))),
		),
	)
	const closed = close_stream(stream.value)
	if (!current()) return discard_staged(staged, ok(undefined))
	let written = confirmed(encoded, "Wallpaper preview encoder failed")
	if (written.ok) written = closed
	return commit_staged(staged, Gio.File.new_for_path(path), written)
}

function cached_preview(key: string, size: number): string | null {
	const shown = wallpaper_preview.peek()
	if (shown?.startsWith(key) && Number(shown.slice(key.length, -4)) >= size)
		return shown
	const exact = `${key}${size}.png`
	if (Gio.File.new_for_path(exact).query_exists(null)) return exact
	return null
}

export function ensure_wallpaper_preview(size: number): void {
	if (!Number.isInteger(size) || size < 1) return
	if (preview_building) {
		preview_wanted = Math.max(preview_wanted, size)
		return
	}
	const expected = signature
	const source = file_size(wallpaper_path)
	if (!expected || !source.ok || source.value <= 0) {
		if (wallpaper_preview.peek() === null) return
		set_wallpaper_preview(null)
		drop_previews(null)
		return
	}
	const hash = GLib.compute_checksum_for_string(
		GLib.ChecksumType.SHA1,
		expected,
		-1,
	)
	const key = `${preview_prefix}-${hash}-`
	const cached = cached_preview(key, size)
	if (cached) {
		set_wallpaper_preview(cached)
		return
	}
	preview_building = true
	const current = generation
	const is_current = () => signature === expected && generation === current
	const path = `${key}${size}.png`
	void save_preview(path, size, is_current).then((saved) => {
		preview_building = false
		const wanted = preview_wanted
		preview_wanted = 0
		const built = log_error(saved, "wallpaper.preview: Failed to build preview")
		if (!is_current()) {
			ensure_wallpaper_preview(Math.max(size, wanted))
			return
		}
		if (built) {
			set_wallpaper_preview(path)
			drop_previews(path)
		}
		if (wanted > 0) ensure_wallpaper_preview(wanted)
	})
}

export function clear_wallpaper(): result<void> {
	generation++
	const file = Gio.File.new_for_path(wallpaper_path)
	const cleared = confirmed(
		attempt(
			() =>
				file.replace_contents(
					"",
					null,
					false,
					Gio.FileCreateFlags.REPLACE_DESTINATION,
					null,
				)[0],
		),
		"Failed to clear wallpaper",
	)
	if (!log_error(cleared, "wallpaper.clear: Failed to clear wallpaper"))
		return cleared
	set_wallpaper_preview(null)
	drop_previews(null)
	refresh()
	return cleared
}

function staging_directory(destination: Gio.File): result<string> {
	const directory = destination.get_parent()
	if (!directory)
		return err(new Error("Wallpaper destination has no parent directory"))
	const path = directory.get_path()
	if (!path)
		return err(new Error("Wallpaper destination is not a local directory"))
	const ready = ensure_directory(path)
	if (!ready.ok) return ready
	return ok(path)
}

function conversion_command(path: string, output: string): result<string[]> {
	const lower = path.toLowerCase()
	if (lower.endsWith(".heic")) {
		if (GLib.find_program_in_path("heif-dec") === null)
			return err(new Error("heif-dec not found"))
		return ok(["heif-dec", path, output])
	}
	if (lower.endsWith(".webp")) {
		if (GLib.find_program_in_path("dwebp") === null)
			return err(new Error("dwebp not found"))
		return ok(["dwebp", path, "-o", output])
	}
	return ok(["cp", "--", path, output])
}

async function stage_wallpaper(
	path: string,
	stream: Gio.OutputStream,
	staged_path: string,
	current: number,
): Promise<result<void>> {
	const closed = confirmed(
		attempt(() => stream.close(null)),
		"Failed to close temporary wallpaper",
	)
	if (!closed.ok) return closed
	const size = check_image_size(path)
	if (!size.ok) return size
	const command = conversion_command(path, staged_path)
	if (!command.ok) return command
	const converted = await run_command(command.value, { timeout_ms: 60_000 })
	if (!converted.ok) return converted
	if (current !== generation) return ok(undefined)
	const decoded = await decode_image(staged_path, validation_size)
	if (!decoded.ok) return decoded
	return ok(undefined)
}

export async function set_wallpaper(path: string): Promise<result<void>> {
	const current = ++generation
	const destination = Gio.File.new_for_path(wallpaper_path)
	const directory = staging_directory(destination)
	if (!directory.ok) return directory
	const staged_path = `${directory.value}/.background-${GLib.uuid_string_random()}.png`
	const staged = Gio.File.new_for_path(staged_path)
	const stream = attempt(() => staged.create(Gio.FileCreateFlags.PRIVATE, null))
	if (!stream.ok) return stream
	const ready = await stage_wallpaper(path, stream.value, staged_path, current)
	if (current !== generation) return discard_staged(staged, ready)
	const committed = commit_staged(staged, destination, ready)
	if (committed.ok) refresh()
	return committed
}
