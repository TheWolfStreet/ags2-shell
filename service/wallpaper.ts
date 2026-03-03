import app from "ags/gtk4/app"
import { createBinding } from "ags"
import GObject, { property, register } from "ags/gobject"
import { execAsync } from "ags/process"

import Gio from "gi://Gio"

import env from "$lib/env"
import { attempt, attemptAsync } from "$lib/result"
import { dependencies } from "$lib/utils"

@register()
export default class Wallpaper extends GObject.Object {
	declare static $gtype: GObject.GType<Wallpaper>
	static instance: Wallpaper

	static get_default() {
		return this.instance ??= new Wallpaper()
	}

	@property(String) wallpaper: string

	constructor() {
		super()
		this.wallpaper = `${env.paths.home}/.config/background`

		let prevMonCount = app.get_monitors().length
		createBinding(app, "monitors").subscribe(() => {
			const monCount = app.get_monitors().length
			if (monCount > prevMonCount) {
				prevMonCount = monCount
				this.notify("wallpaper")
			}
		})
	}

	async #convertHeic(path: string) {
		if (!dependencies("heif-dec")) return
		const tmpImg = `${env.paths.tmp}/heic.png`
		await execAsync(["heif-dec", path, tmpImg])
		await execAsync(["cp", tmpImg, this.wallpaper])
	}

	async clearWallpaper() {
		const result = attempt(() => {
			Gio.File.new_for_path(this.wallpaper).replace_contents(
				"",
				null,
				false,
				Gio.FileCreateFlags.REPLACE_DESTINATION,
				null,
			)
			this.notify("wallpaper")
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
				if (!dependencies("dwebp")) throw new Error("dwebp not found")
				const tmp = `${env.paths.tmp}/wallpaper.png`
				await execAsync(["dwebp", path, "-o", tmp])
				await execAsync(["cp", tmp, this.wallpaper])
			} else {
				await execAsync(["cp", path, this.wallpaper])
			}
			this.notify("wallpaper")
		})
		if (!result.ok)
			console.error("wallpaper.set: Failed to set wallpaper", result.err)
	}
}
