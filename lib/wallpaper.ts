// Watches and updates the wallpaper file shared by the shell processes.

import app from "ags/gtk4/app"
import { createState } from "ags"
import { execAsync } from "ags/process"
import { interval } from "ags/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import env from "$lib/env"
import { hasProgram } from "$lib/programs"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/time"

export const wallpaperPath = `${env.paths.home}/.config/background`
const [wallpaperRevision, setWallpaperRevision] = createState(0)
export { wallpaperRevision }

let signature = fileSignature()
let monitor: Gio.FileMonitor | null = null

function fileSignature(): string {
	const result = attempt(() => {
		const info = Gio.File.new_for_path(wallpaperPath).query_info(
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
	return result.ok ? result.value : "missing"
}

const refreshWallpaper = debounce(75, () => {
	const next = fileSignature()
	if (next === signature) return
	signature = next
	setWallpaperRevision((revision) => revision + 1)
})

const watched = attempt(() =>
	Gio.File.new_for_path(GLib.path_get_dirname(wallpaperPath)).monitor_directory(
		Gio.FileMonitorFlags.NONE,
		null,
	),
)
if (watched.ok) {
	monitor = watched.value
	monitor.connect("changed", (_monitor, file, other) => {
		if (
			file.get_path() === wallpaperPath ||
			other?.get_path() === wallpaperPath
		)
			refreshWallpaper.call()
	})
} else
	console.error("wallpaper: Failed to monitor wallpaper directory", watched.err)

const pollTimer = interval(1000, () => refreshWallpaper.call())

app.connect("shutdown", () => {
	refreshWallpaper.cancel()
	pollTimer.cancel()
	monitor?.cancel()
	monitor = null
})

async function convertWallpaper(path: string, program: string, args: string[]) {
	if (!hasProgram(program)) throw new Error(`${program} not found`)
	const temporary = `${env.paths.tmp}/wallpaper-${GLib.uuid_string_random()}.png`
	try {
		await execAsync([program, path, ...args, temporary])
		await execAsync(["cp", temporary, wallpaperPath])
	} finally {
		attempt(() => Gio.File.new_for_path(temporary).delete(null))
	}
}

export function clearWallpaper(): void {
	const result = attempt(() => {
		Gio.File.new_for_path(wallpaperPath).replace_contents(
			"",
			null,
			false,
			Gio.FileCreateFlags.REPLACE_DESTINATION,
			null,
		)
		refreshWallpaper.call()
	})
	if (!result.ok)
		console.error("wallpaper.clear: Failed to clear wallpaper", result.err)
}

export async function setWallpaper(path: string): Promise<void> {
	const lower = path.toLowerCase()
	const result = await attemptAsync(async () => {
		if (lower.endsWith(".heic")) await convertWallpaper(path, "heif-dec", [])
		else if (lower.endsWith(".webp"))
			await convertWallpaper(path, "dwebp", ["-o"])
		else await execAsync(["cp", path, wallpaperPath])
		refreshWallpaper.call()
	})
	if (!result.ok)
		console.error("wallpaper.set: Failed to set wallpaper", result.err)
}
