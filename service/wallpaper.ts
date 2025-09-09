import GObject, { property, register } from "ags/gobject"
import { monitorFile } from "ags/file"
import { execAsync } from "ags/process"

import { env } from "$lib/env"
import { bash, dependencies } from "$lib/utils"

@register({ GTypeName: "Wallpaper" })
export default class Wallpaper extends GObject.Object {
	static instance: Wallpaper

	static get_default() {
		return this.instance ??= new Wallpaper()
	}
	@property(String) wallpaper = `${env.paths.home}/.config/background`
	#updating = false

	constructor() {
		super()
		if (!dependencies("swww")) return this
		monitorFile(this.wallpaper, () => {
			if (!this.#updating) this.#apply()
		})
		execAsync("swww-daemon").catch(() => null)
	}

	async #handleHeic(imgPath: string): Promise<string> {
		const tmpImg = `${env.paths.tmp}/heic.png`
		await bash(`heif-dec "${imgPath}" "${tmpImg}" && cp "${tmpImg}" "${`${env.paths.home}/.config/background`}"`)
		return this.wallpaper
	}

	get_wallpaper() {
		return this.wallpaper
	}

	async set_wallpaper(imgPath: string) {
		if (!dependencies("swww")) return
		this.#updating = true

		const isHeic = imgPath.toLowerCase().endsWith(".heic")
		const hasLibHeic = dependencies("heif-dec")

		try {
			if (isHeic && hasLibHeic) {
				await this.#handleHeic(imgPath)
			} else {
				await bash(`cp "${imgPath}" "${`${env.paths.home}/.config/background`}"`)
			}
		} catch (e) {
			console.error("Failed to set wallpaper:", e)
		} finally {
			await this.#apply()
			this.#updating = false
		}
	}

	readonly #apply = async () => {
		if (!dependencies("swww")) return

		await bash("hyprctl cursorpos").then(cursorPos =>
			execAsync(`swww img --invert-y --transition-type fade --transition-pos ${cursorPos.replace(/ /g, "")} "${this.wallpaper}"`)
				.then(() => this.notify("wallpaper")).catch(() => { })
		)
		this.notify("wallpaper")
	}
}
