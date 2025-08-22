import GObject, { getter, register, setter } from "ags/gobject"
import { monitorFile } from "ags/file"
import { execAsync } from "ags/process"

import { env } from "$lib/env"
import { bash, bashSync, dependencies } from "$lib/utils"

const wpPath = `${env.paths.home}/.config/background`

@register({ GTypeName: "Wallpaper" })
export default class Wallpaper extends GObject.Object {
	static instance: Wallpaper

	static get_default() {
		return this.instance ??= new Wallpaper()
	}

	#updating = false

	constructor() {
		super()
		if (!dependencies("swww")) return this

		monitorFile(wpPath, () => {
			if (!this.#updating) this.#setWp()
		})
		execAsync("swww-daemon").catch(() => null)
	}

	@getter(String)
	get wallpaper() {
		return wpPath
	}

	@setter(String)
	set wallpaper(imgPath: string) {
		if (!dependencies("swww")) return
		this.#updating = true

		const onWpUpdated = () => {
			this.#setWp()
			this.#updating = false
		}

		const isHeic = imgPath.toLowerCase().endsWith(".heic")
		const hasLibHeic = dependencies("heif-dec")

		if (isHeic && hasLibHeic) {
			const tmpImg = `${env.paths.tmp}/heic.png`
			bash(`heif-dec "${imgPath}" "${tmpImg}" && cp "${tmpImg}" "${wpPath}"`)
				.catch(() => { this.#updating = false })
				.then(onWpUpdated)
		} else {
			bashSync(`cp "${imgPath}" "${wpPath}"`)
			onWpUpdated()
		}
	}

	readonly #setWp = () => {
		if (!dependencies("swww")) return

		bash("hyprctl cursorpos").then(cursorPos =>
			execAsync(`swww img --invert-y --transition-type fade --transition-pos ${cursorPos.replace(/ /g, "")} "${wpPath}"`)
				.then(() => this.notify("wallpaper"))
		)
	}
}
