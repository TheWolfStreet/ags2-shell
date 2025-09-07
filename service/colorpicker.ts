import GObject, { getter, register, setter } from "ags/gobject"
import { readFile, writeFile } from "ags/file"
import { execAsync } from "ags/process"

import GLib from "gi://GLib"

import { dependencies, notify, wlCopy } from "$lib/utils"
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

	readonly pick = async (existing?: string) => {
		if (!existing && !dependencies("wl-copy", "hyprpicker")) return
		if (existing && !dependencies("wl-copy")) return

		let color = existing
		if (!color) {
			color = await execAsync("hyprpicker -r")
			color = color.replace("[ERR] renderSurface: PBUFFER null", "").trim()
			if (!color) return
		}

		wlCopy(color)

		if (!existing) {
			const max = options.colorpicker.maxColors.get()
			const colors = [...this.#colors]

			if (!colors.includes(color)) {
				colors.push(color)
				if (colors.length > max) colors.shift()
				this.#colors = colors
				this.notify("colors")
				writeFile(cacheFile, JSON.stringify(colors, null, 0))
			}
		}

		notify({
			id: this.#notifId,
			appName: "Colorpicker",
			appIcon: icons.ui.colorpicker,
			summary: "Copied to clipboard",
			body: color,
		}).then(id => {
			if (id) this.#notifId = id
		})
	}
}
