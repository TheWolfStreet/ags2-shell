import { register, property, GLib, GObject, readFile, writeFile, execAsync } from "astal"

import { dependencies, notify } from "../lib/utils"
import { env } from "../lib/environment"
import icons from "../lib/icons"
import options from "../options"

const cacheFile = `${env.paths.cache}/colors.js`

if (!GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) {
	writeFile(cacheFile, "[]")
}

@register({ GTypeName: "ColorPicker" })
export default class ColorPicker extends GObject.Object {
	static instance: ColorPicker

	static get_default() {
		if (!this.instance) {
			this.instance = new ColorPicker()
		}
		return this.instance
	}

	#notifID = 0
	#colors = JSON.parse(readFile(cacheFile) || "[]") as string[]

	@property(String)
	get colors() {
		return this.#colors
	}

	set colors(colors) {
		this.#colors = colors
	}

	async wlCopy(color: string) {
		if (!dependencies("wl-copy", "hyprpicker")) {
			return
		}
		await execAsync(`wl-copy "${color}"`)
	}

	readonly pick = async () => {
		if (!dependencies("wl-copy", "hyprpicker")) {
			return
		}

		const color = await execAsync("hyprpicker -r")
		if (!color) {
			return
		}

		this.wlCopy(color)
		const list = this.#colors
		if (!list.includes(color)) {
			list.push(color)
			if (list.length > options.colorpicker.maxColors.get()) {
				list.shift()
			}

			this.#colors = list
			this.notify("colors")
			writeFile(cacheFile, JSON.stringify(list, null, 2))
		}

		this.#notifID = await notify({
			id: this.#notifID,
			appName: "Colorpicker",
			appIcon: icons.ui.colorpicker,
			summary: "Copied to clipboard",
			body: color,
		})
	}
}
