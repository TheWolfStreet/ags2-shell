import GObject, { getter, register, setter } from "ags/gobject"
import { readFile, writeFile } from "ags/file"
import { execAsync } from "ags/process"

import GLib from "gi://GLib"

import { dependencies, notify } from "$lib/utils"
import { env } from "$lib/env"
import icons from "$lib/icons"

import options from "options"

const cacheFile = `${env.paths.cache}/colors.js`

if (!GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) {
	writeFile(cacheFile, "[]")
}

@register({ GTypeName: "ColorPicker" })
export default class ColorPicker extends GObject.Object {
	static instance: ColorPicker

	static get_default() {
		return this.instance ??= new ColorPicker()
	}

	#notifId = 0
	#colors = JSON.parse(readFile(cacheFile) || "[]") as string[]

	@getter(Array)
	get colors() {
		return this.#colors
	}
	@setter(Array)
	set colors(value) {
		this.#colors = value
	}

	readonly copyColor = async (color: string) => {
		if (!dependencies("wl-copy", "hyprpicker")) return

		await execAsync(`wl-copy "${color}"`)
	}

	readonly pickColor = async () => {
		if (!dependencies("wl-copy", "hyprpicker")) return

		const color = await execAsync("hyprpicker -r")
		if (!color) return

		await this.copyColor(color)

		const colors = this.#colors
		if (!colors.includes(color)) {
			colors.push(color)
			const maxColors = options.colorpicker.maxColors.get()
			if (colors.length > maxColors) {
				colors.shift()
			}

			this.#colors = colors
			this.notify("colors")
			writeFile(cacheFile, JSON.stringify(colors, null, 2))
		}

		this.#notifId = await notify({
			id: this.#notifId,
			appName: "Colorpicker",
			appIcon: icons.ui.colorpicker,
			summary: "Copied to clipboard",
			body: color,
		})
	}
}
