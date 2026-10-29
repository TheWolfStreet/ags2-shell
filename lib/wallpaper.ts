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
export const wallpaper_preview_path = `${env.paths.cache.base}/wallpaper-preview.png`
const preview_metadata_path = `${env.paths.cache.base}/wallpaper-preview.json`
const validation_size = 256
const [wallpaper_revision, set_wallpaper_revision] = createState(0)
export { wallpaper_revision }
const [wallpaper_preview_revision, set_wallpaper_preview_revision] =
	createState(0)
export { wallpaper_preview_revision }

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

function finish_preview(result: Gio.AsyncResult): result<void> {
	const image = attempt(() => GdkPixbuf.Pixbuf.new_from_stream_finish(result))
	if (!image.ok) return image
	if (!image.value) return err(new Error("Wallpaper decoder returned no image"))
	return ok(undefined)
}

function decode_preview(stream: Gio.InputStream) {
	return start_async<void>((finish) =>
		GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
			stream,
			validation_size,
			validation_size,
			true,
			null,
			(_source, result) => finish(finish_preview(result)),
		),
	)
}

function close_stream(stream: Gio.InputStream): result<void> {
	const closed = attempt(() => stream.close(null))
	if (closed.ok && closed.value) return ok(undefined)
	return err(
		new Error("Failed to close wallpaper validation stream", {
			cause: closed.ok ? undefined : closed.err,
		}),
	)
}

async function validate_image(path: string): Promise<result<void>> {
	const size = check_image_size(path)
	if (!size.ok) return size
	const info = await read_image_info(path)
	if (!info.ok) return info
	const [format, width, height] = info.value
	if (!format || !valid_image_dimensions(width, height))
		return err(new Error("Wallpaper format or dimensions are unsupported"))
	const stream = await open_stream(path)
	if (!stream.ok) return stream
	const decoded = await decode_preview(stream.value)
	const closed = close_stream(stream.value)
	if (closed.ok) return decoded
	log_error(decoded, "wallpaper.validate: Failed to decode wallpaper")
	return closed
}

type preview_metadata = { signature: string; size: number }

let preview_pending = false

function delete_if_present(path: string): result<void> {
	const file = Gio.File.new_for_path(path)
	if (!file.query_exists(null)) return ok(undefined)
	const removed = attempt(() => file.delete(null))
	if (!removed.ok) return removed
	if (!removed.value) return err(new Error(`Failed to remove ${path}`))
	return ok(undefined)
}

function read_preview_metadata(): preview_metadata | null {
	const loaded = attempt(() => {
		const [, contents] = Gio.File.new_for_path(
			preview_metadata_path,
		).load_contents(null)
		return new TextDecoder().decode(contents)
	})
	if (!loaded.ok) return null
	const parsed = attempt((): unknown => JSON.parse(loaded.value))
	if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null)
		return null
	const { signature: cached, size } = parsed.value as Record<string, unknown>
	if (typeof cached !== "string" || typeof size !== "number") return null
	return { signature: cached, size }
}

function write_preview_metadata(metadata: preview_metadata): result<void> {
	const written = attempt(() =>
		Gio.File.new_for_path(preview_metadata_path).replace_contents(
			JSON.stringify(metadata),
			null,
			false,
			Gio.FileCreateFlags.REPLACE_DESTINATION,
			null,
		),
	)
	if (!written.ok) return written
	if (!written.value[0])
		return err(new Error("Failed to record wallpaper preview metadata"))
	return ok(undefined)
}

function discard_wallpaper_preview() {
	log_error(
		delete_if_present(preview_metadata_path),
		"wallpaper.preview: Failed to drop preview metadata",
	)
	log_error(
		delete_if_present(wallpaper_preview_path),
		"wallpaper.preview: Failed to drop cached preview",
	)
	set_wallpaper_preview_revision((revision) => revision + 1)
}

function preview_is_current(size: number): boolean {
	const metadata = read_preview_metadata()
	if (!metadata) return false
	if (metadata.signature !== signature || metadata.size < size) return false
	return GLib.file_test(wallpaper_preview_path, GLib.FileTest.EXISTS)
}

function decode_scaled(stream: Gio.InputStream, size: number) {
	return start_async<GdkPixbuf.Pixbuf | null>((finish) =>
		GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
			stream,
			size,
			size,
			true,
			null,
			(_source, result) =>
				finish(attempt(() => GdkPixbuf.Pixbuf.new_from_stream_finish(result))),
		),
	)
}

function replace_stream(path: string) {
	const file = Gio.File.new_for_path(path)
	return start_async<Gio.FileOutputStream>((finish) =>
		file.replace_async(
			null,
			false,
			Gio.FileCreateFlags.REPLACE_DESTINATION,
			GLib.PRIORITY_DEFAULT,
			null,
			(_source, result) => finish(attempt(() => file.replace_finish(result))),
		),
	)
}

function close_output(stream: Gio.OutputStream): result<void> {
	const closed = attempt(() => stream.close(null))
	if (closed.ok && closed.value) return ok(undefined)
	return err(
		new Error("Failed to close wallpaper preview stream", {
			cause: closed.ok ? undefined : closed.err,
		}),
	)
}

function finish_encode(result: Gio.AsyncResult): result<void> {
	const saved = attempt(() => GdkPixbuf.Pixbuf.save_to_stream_finish(result))
	if (!saved.ok) return saved
	if (!saved.value) return err(new Error("Wallpaper preview encoder failed"))
	return ok(undefined)
}

function encode_preview(image: GdkPixbuf.Pixbuf, stream: Gio.OutputStream) {
	return start_async<void>((finish) =>
		image.save_to_streamv_async(
			stream,
			"png",
			[],
			[],
			null,
			(_source, result) => finish(finish_encode(result)),
		),
	)
}

async function save_preview(image: GdkPixbuf.Pixbuf): Promise<result<void>> {
	const staged_path = `${wallpaper_preview_path}.${GLib.uuid_string_random()}`
	const discard = (outcome: result<void>) => {
		log_error(
			delete_if_present(staged_path),
			"wallpaper.preview: Failed to remove staged preview",
		)
		return outcome
	}
	const stream = await replace_stream(staged_path)
	if (!stream.ok) return discard(stream)
	const encoded = await encode_preview(image, stream.value)
	const closed = close_output(stream.value)
	if (!encoded.ok) return discard(encoded)
	if (!closed.ok) return discard(closed)
	const moved = attempt(() =>
		Gio.File.new_for_path(staged_path).move(
			Gio.File.new_for_path(wallpaper_preview_path),
			Gio.FileCopyFlags.OVERWRITE,
			null,
			null,
		),
	)
	if (moved.ok && moved.value) return ok(undefined)
	return discard(moved.ok ? err(new Error("Failed to replace preview")) : moved)
}

async function build_preview(
	size: number,
	expected: string,
): Promise<result<void>> {
	const info = await read_image_info(wallpaper_path)
	if (!info.ok) return info
	const [format, width, height] = info.value
	if (!format || !valid_image_dimensions(width, height))
		return err(new Error("Wallpaper format or dimensions are unsupported"))
	const target = Math.max(1, Math.min(size, Math.max(width, height)))
	const stream = await open_stream(wallpaper_path)
	if (!stream.ok) return stream
	const image = await decode_scaled(stream.value, target)
	const closed = close_stream(stream.value)
	log_error(closed, "wallpaper.preview: Failed to close wallpaper")
	if (!image.ok) return image
	if (!image.value) return err(new Error("Wallpaper decoder returned no image"))
	if (signature !== expected) return ok(undefined)
	const saved = await save_preview(image.value)
	if (!saved.ok) return saved
	return write_preview_metadata({ signature: expected, size })
}

export function ensure_wallpaper_preview(size: number): void {
	if (preview_pending || !Number.isInteger(size) || size < 1) return
	const expected = signature
	if (!expected) return
	const source = file_size(wallpaper_path)
	if (!source.ok || source.value <= 0) return
	if (preview_is_current(size)) return
	preview_pending = true
	const current = generation
	void build_preview(size, expected).then((built) => {
		preview_pending = false
		if (current !== generation) return
		if (log_error(built, "wallpaper.preview: Failed to build preview"))
			set_wallpaper_preview_revision((revision) => revision + 1)
		if (signature !== expected) ensure_wallpaper_preview(size)
	})
}

function empty_wallpaper(): result<void> {
	const file = Gio.File.new_for_path(wallpaper_path)
	const replaced = attempt(() =>
		file.replace_contents(
			"",
			null,
			false,
			Gio.FileCreateFlags.REPLACE_DESTINATION,
			null,
		),
	)
	if (!replaced.ok) return replaced
	if (!replaced.value[0]) return err(new Error("Failed to clear wallpaper"))
	return ok(undefined)
}

export function clear_wallpaper(): result<void> {
	generation++
	const cleared = empty_wallpaper()
	if (!log_error(cleared, "wallpaper.clear: Failed to clear wallpaper"))
		return cleared
	discard_wallpaper_preview()
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
	const closed = attempt(() => stream.close(null))
	if (!closed.ok) return closed
	if (!closed.value)
		return err(new Error("Failed to close temporary wallpaper"))
	const size = check_image_size(path)
	if (!size.ok) return size
	const command = conversion_command(path, staged_path)
	if (!command.ok) return command
	const converted = await run_command(command.value, { timeout_ms: 60_000 })
	if (!converted.ok) return converted
	if (current !== generation) return ok(undefined)
	return validate_image(staged_path)
}

function remove_staged(staged: Gio.File): result<void> {
	const removed = attempt(() => staged.delete(null))
	if (!removed.ok) return removed
	if (!removed.value)
		return err(new Error("Temporary wallpaper was not removed"))
	return ok(undefined)
}

function discard_staged(staged: Gio.File, outcome: result<void>): result<void> {
	const removed = remove_staged(staged)
	if (removed.ok) return outcome
	if (outcome.ok)
		return with_context(removed, "Failed to remove temporary wallpaper")
	console.error(
		"wallpaper.set: Failed to remove temporary wallpaper",
		removed.err,
	)
	return outcome
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
	if (!ready.ok || current !== generation) return discard_staged(staged, ready)
	const moved = attempt(() =>
		staged.move(destination, Gio.FileCopyFlags.OVERWRITE, null, null),
	)
	if (!moved.ok) return discard_staged(staged, moved)
	if (!moved.value)
		return discard_staged(staged, err(new Error("Failed to replace wallpaper")))
	refresh()
	return ok(undefined)
}
