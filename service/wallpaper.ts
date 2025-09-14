import GObject, { property, register } from "ags/gobject"
import { monitorFile } from "ags/file"
import { execAsync } from "ags/process"

import { env } from "$lib/env"
import { bashSync, dependencies } from "$lib/utils"

@register({ GTypeName: "Wallpaper" })
export default class Wallpaper extends GObject.Object {
	static instance: Wallpaper

	static get_default() {
		return this.instance ??= new Wallpaper()
	}
	@property(String) wallpaper = `${env.paths.home}/.config/background`

	constructor() {
		super()
		if (!dependencies("swww")) return this
		monitorFile(this.wallpaper, () => {
			this.notify("wallpaper")
			this.#apply()
		})
		execAsync("swww-daemon").catch(() => null)
	}

	#handleHeic(imgPath: string) {
		if (!dependencies("heif-dec")) return
		const tmpImg = `${env.paths.tmp}/heic.png`
		bashSync(`heif-dec "${imgPath}" "${tmpImg}" && cp "${tmpImg}" "${`${env.paths.home}/.config/background`}"`)
	}

	get_wallpaper() {
		return this.wallpaper
	}

	async set_wallpaper(imgPath: string) {
		if (!dependencies("swww")) return
		const isHeic = imgPath.toLowerCase().endsWith(".heic")

		try {
			if (isHeic) {
				this.#handleHeic(imgPath)
			} else {
				bashSync(`cp "${imgPath}" "${`${env.paths.home}/.config/background`}"`)
			}
		} catch (e) {
			console.error("Failed to set wallpaper:", e)
		}
	}

	readonly #apply = async () => {
		await execAsync(
			`swww img --invert-y --transition-type fade "${this.wallpaper}"`
		)
	}
}
