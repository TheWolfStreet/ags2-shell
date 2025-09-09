import GObject, { getter, register, setter } from "ags/gobject"
import { timeout, Timer } from "ags/time"
import { readFile, writeFileAsync } from "ags/file"
import { execAsync } from "ags/process"

import { dependencies, ensurePath, notify, wlCopy } from "$lib/utils"
import { env } from "$lib/env"
import icons from "$lib/icons"

import options from "options"

const cacheFile = `${env.paths.cache}/colors.json`

@register({ GTypeName: "ColorPicker" })
export default class ColorPicker extends GObject.Object {
	static instance: ColorPicker

	constructor() {
		ensurePath(cacheFile)
		super()
	}

	static get_default() {
		return this.instance ??= new ColorPicker()
	}

	#notifId = 0
	#saveDebounce: Timer | null = null
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

				if (this.#saveDebounce) this.#saveDebounce.cancel()
				this.#saveDebounce = timeout(1000, async () => {
					try {
						ensurePath(cacheFile)
						await writeFileAsync(cacheFile, JSON.stringify(this.#colors, null, 0))
					} catch (e) {
						console.error("failed to save colors", e)
					}
					this.#saveDebounce = null
				})
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
