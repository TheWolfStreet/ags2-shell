import { GObject, register, monitorFile, execAsync, property } from "astal"

import { env } from "../lib/environment"
import { bash, bashSync, dependencies } from "../lib/utils"

const wp = `${env.paths.home}/.config/background`

@register({ GTypeName: "Wallpaper" })
export default class Wallpaper extends GObject.Object {
	static instance: Wallpaper
	static get_default() {
		if (!this.instance)
			this.instance = new Wallpaper()

		return this.instance
	}

	#lock = false
	#wallpaper() {
		if (!dependencies("swww")) {
			return
		}

		bash("hyprctl cursorpos").then(pos => {
			execAsync(`swww img --invert-y --transition-type fade --transition-pos ${pos.replace(" ", "")} "${wp}"`).then(() => {
				this.notify("wallpaper")
			})
		})
	}

	@property(String)
	get wallpaper() {
		return wp
	}

	set wallpaper(path: string) {
		if (!dependencies("swww")) return

		this.#lock = true

		const finalize = () => {
			this.#wallpaper()
			this.#lock = false
		}

		if (path.toLowerCase().endsWith(".heic")) {
			const tmp = `${env.paths.tmp}/heic.png`
			dependencies("heif-dec") &&
				bash(`heif-dec "${path}" "${tmp}" && cp "${tmp}" "${wp}"`).catch(() => this.#lock = false).then(finalize)
		} else {
			bashSync(`cp "${path}" "${wp}"`)
			finalize()
		}
	}

	constructor() {
		super()

		if (!dependencies("swww")) {
			return this
		}

		monitorFile(wp, () => {
			if (!this.#lock)
				this.wallpaper
		})
		execAsync("swww-daemon").catch(() => null)
	}
}
