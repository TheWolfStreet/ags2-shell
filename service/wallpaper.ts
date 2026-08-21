// Watches, replaces, converts, and clears the configured wallpaper file.

import app from "ags/gtk4/app"
import GObject, { property, register } from "ags/gobject"
import { execAsync } from "ags/process"
import { interval, Timer } from "ags/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import env from "$lib/env"
import { hasProgram } from "$lib/programs"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/time"

@register()
class WallpaperService extends GObject.Object {
	declare static $gtype: GObject.GType<WallpaperService>
	static instance: WallpaperService

	static get_default() {
		return this.instance ??= new WallpaperService()
	}

	@property(String) wallpaper: string
	@property(Number) revision: number
	#monitor: Gio.FileMonitor | null
	#pollTimer: Timer
	#signature: string
	#notify = debounce(75, () => {
		this.#signature = this.#fileSignature()
		this.revision++
		this.notify("wallpaper")
	})

	constructor() {
		super()
		this.wallpaper = `${env.paths.home}/.config/background`
		this.revision = 0
		this.#monitor = null
		this.#signature = this.#fileSignature()

		const watched = attempt(() => Gio.File.new_for_path(GLib.path_get_dirname(this.wallpaper))
			.monitor_directory(Gio.FileMonitorFlags.NONE, null))
		if (watched.ok) {
			this.#monitor = watched.value
			this.#monitor.connect("changed", (_, file, other) => {
				if (file.get_path() === this.wallpaper || other?.get_path() === this.wallpaper)
					this.#notify.call()
			})
		} else console.error("wallpaper: Failed to monitor wallpaper directory", watched.err)

		this.#pollTimer = interval(1000, () => {
			const signature = this.#fileSignature()
			if (signature !== this.#signature) this.#notify.call()
		})

		app.connect("shutdown", () => {
			this.#notify.cancel()
			this.#pollTimer.cancel()
			this.#monitor?.cancel()
		})
	}

	#fileSignature() {
		const result = attempt(() => {
			const info = Gio.File.new_for_path(this.wallpaper).query_info(
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

	async #convertHeic(path: string) {
		if (!hasProgram("heif-dec")) {
			console.error("wallpaper: Missing dependency heif-dec")
			throw new Error("heif-dec not found")
		}
		const tmpImg = `${env.paths.tmp}/heic.png`
		await execAsync(["heif-dec", path, tmpImg])
		await execAsync(["cp", tmpImg, this.wallpaper])
	}

	clearWallpaper() {
		const result = attempt(() => {
			Gio.File.new_for_path(this.wallpaper).replace_contents(
				"",
				null,
				false,
				Gio.FileCreateFlags.REPLACE_DESTINATION,
				null,
			)
			this.#notify.call()
		})
		if (!result.ok)
			console.error("wallpaper.clear: Failed to clear wallpaper", result.err)
	}

	async setWallpaper(path: string) {
		const lower = path.toLowerCase()
		const result = await attemptAsync(async () => {
			if (lower.endsWith(".heic")) {
				await this.#convertHeic(path)
			} else if (lower.endsWith(".webp")) {
				if (!hasProgram("dwebp")) {
					console.error("wallpaper: Missing dependency dwebp")
					throw new Error("dwebp not found")
				}
				const tmp = `${env.paths.tmp}/wallpaper.png`
				await execAsync(["dwebp", path, "-o", tmp])
				await execAsync(["cp", tmp, this.wallpaper])
			} else {
				await execAsync(["cp", path, this.wallpaper])
			}
			this.#notify.call()
		})
		if (!result.ok)
			console.error("wallpaper.set: Failed to set wallpaper", result.err)
	}
}

export const wallpaperService = WallpaperService.get_default()
