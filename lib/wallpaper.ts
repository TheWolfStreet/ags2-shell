import app from "$lib/app"
import { createState } from "ags"
import { execAsync } from "ags/process"
import { interval, type Timer } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"

import env from "$lib/env"
import { attempt, attempt_async, err, ok, type Result } from "$lib/result"
import { debounce } from "$lib/time"

export const wallpaper_path = `${env.paths.home}/.config/background`
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 8192
const MAX_IMAGE_PIXELS = 40_000_000
const VALIDATION_SIZE = 256
const [wallpaper_revision, set_wallpaper_revision] = createState(0)
export { wallpaper_revision }

let generation = 0
let signature: string | null = null
let signature_error: string | null = null
let monitor: Gio.FileMonitor | null = null
let poll_timer: Timer | null = null

function update_polling() {
	if (!monitor || GLib.file_test(wallpaper_path, GLib.FileTest.IS_SYMLINK)) {
		poll_timer ??= interval(1000, () => {
			refresh_wallpaper.call()
			update_polling()
		})
	} else {
		poll_timer?.cancel()
		poll_timer = null
	}
}

function file_signature(): Result<string | null> {
	const result = attempt(() => {
		const info = Gio.File.new_for_path(wallpaper_path).query_info(
			"standard::size,time::modified,time::modified-usec,etag::value",
			Gio.FileQueryInfoFlags.NONE,
			null,
		)
		return [
			info.get_size(),
			info.get_attribute_uint64("time::modified"),
			info.get_attribute_uint32("time::modified-usec"),
			info.get_attribute_string("etag::value") ?? "",
		].join(":")
	})
	if (result.ok) return result
	if (result.err instanceof GLib.Error && result.err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND))
		return ok(null)
	return result
}

function read_signature(): string | null {
	const result = file_signature()
	if (result.ok) {
		signature_error = null
		return result.value
	}
	const message = String(result.err)
	if (signature_error !== message) console.error("wallpaper: Failed to inspect wallpaper", result.err)
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

const watched = attempt(() =>
	Gio.File.new_for_path(GLib.path_get_dirname(wallpaper_path)).monitor_directory(
		Gio.FileMonitorFlags.NONE,
		null,
	),
)
if (watched.ok) {
	monitor = watched.value
	monitor.connect("changed", (_monitor, file, other) => {
		if (file.get_path() === wallpaper_path || other?.get_path() === wallpaper_path) {
			refresh_wallpaper.call()
			update_polling()
		}
	})
} else {
	console.error("wallpaper: Failed to monitor wallpaper directory", watched.err)
}
update_polling()

app.connect("shutdown", () => {
	generation++
	refresh_wallpaper.cancel()
	poll_timer?.cancel()
	monitor?.cancel()
	monitor = null
})

function check_image_size(file: Gio.File) {
	const size = file.query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null).get_size()
	if (size <= 0 || size > MAX_IMAGE_BYTES)
		throw new Error(`Wallpaper must be nonempty and no larger than ${MAX_IMAGE_BYTES} bytes`)
}

async function validate_image(file: Gio.File, path: string) {
	check_image_size(file)
	const [format, width, height] = await new Promise<[GdkPixbuf.PixbufFormat | null, number, number]>((resolve, reject) => {
		GdkPixbuf.Pixbuf.get_file_info_async(path, null, (_source, result) => {
			const info = attempt(() => GdkPixbuf.Pixbuf.get_file_info_finish(result))
			if (info.ok) resolve(info.value)
			else reject(info.err)
		})
	})
	if (!format || width <= 0 || height <= 0 || width > MAX_IMAGE_DIMENSION ||
		height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS)
		throw new Error("Wallpaper format or dimensions are unsupported")

	const stream = await new Promise<Gio.FileInputStream>((resolve, reject) => {
		file.read_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
			const opened = attempt(() => file.read_finish(result))
			if (opened.ok) resolve(opened.value)
			else reject(opened.err)
		})
	})
	const decoded = await attempt_async(() => new Promise<void>((resolve, reject) => {
		GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
			stream, VALIDATION_SIZE, VALIDATION_SIZE, true, null,
			(_source, result) => {
				const image = attempt(() => GdkPixbuf.Pixbuf.new_from_stream_finish(result))
				if (image.ok && image.value) resolve()
				else reject(image.ok ? new Error("Wallpaper decoder returned no image") : image.err)
			},
		)
	}))
	const closed = attempt(() => stream.close(null))
	if (!closed.ok || !closed.value) {
		if (!decoded.ok) console.error("wallpaper.validate: Failed to decode wallpaper", decoded.err)
		throw new Error("Failed to close wallpaper validation stream", { cause: closed.ok ? undefined : closed.err })
	}
	if (!decoded.ok) throw decoded.err
}

export function clear_wallpaper(): Result<void> {
	generation++
	const result = attempt(() => {
		const [replaced] = Gio.File.new_for_path(wallpaper_path).replace_contents(
			"",
			null,
			false,
			Gio.FileCreateFlags.REPLACE_DESTINATION,
			null,
		)
		if (!replaced) throw new Error("Failed to clear wallpaper")
		refresh_wallpaper.call()
		update_polling()
	})
	if (!result.ok) console.error("wallpaper.clear: Failed to clear wallpaper", result.err)
	return result
}

export async function set_wallpaper(path: string): Promise<Result<void>> {
	const current = ++generation
	let temporary: Gio.File | null = null
	let created = false
	let moved = false
	let result = await attempt_async(async () => {
		const destination = Gio.File.new_for_path(wallpaper_path)
		const directory = destination.get_parent()
		if (!directory) throw new Error("Wallpaper destination has no parent directory")
		if (!directory.query_exists(null)) directory.make_directory_with_parents(null)
		const directory_path = directory.get_path()
		if (!directory_path) throw new Error("Wallpaper destination is not a local directory")
		const temporary_path = `${directory_path}/.background-${GLib.uuid_string_random()}.png`
		temporary = Gio.File.new_for_path(temporary_path)
		const stream = temporary.create(Gio.FileCreateFlags.PRIVATE, null)
		created = true
		if (!stream.close(null)) throw new Error("Failed to close temporary wallpaper")
		check_image_size(Gio.File.new_for_path(path))

		const lower = path.toLowerCase()
		if (lower.endsWith(".heic")) {
			if (GLib.find_program_in_path("heif-dec") === null) throw new Error("heif-dec not found")
			await execAsync(["heif-dec", path, temporary_path])
		} else if (lower.endsWith(".webp")) {
			if (GLib.find_program_in_path("dwebp") === null) throw new Error("dwebp not found")
			await execAsync(["dwebp", path, "-o", temporary_path])
		} else {
			await execAsync(["cp", "--", path, temporary_path])
		}
		if (current !== generation) return
		await validate_image(temporary, temporary_path)
		if (current !== generation) return
		if (!temporary.move(destination, Gio.FileCopyFlags.OVERWRITE, null, null))
			throw new Error("Failed to replace wallpaper")
		moved = true
		refresh_wallpaper.call()
		update_polling()
	})
	if (temporary && created && !moved) {
		const removed = attempt(() => {
			if (!temporary!.delete(null)) throw new Error("Temporary wallpaper was not removed")
		})
		if (!removed.ok) {
			if (result.ok) result = err(new Error("Failed to remove temporary wallpaper", { cause: removed.err }))
			else console.error("wallpaper.set: Failed to remove temporary wallpaper", removed.err)
		}
	}
	return result
}
