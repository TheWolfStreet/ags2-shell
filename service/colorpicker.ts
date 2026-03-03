import GObject, { getter, register, setter } from "ags/gobject"
import { readFile, writeFileAsync } from "ags/file"
import { execAsync } from "ags/process"

import env from "$lib/env"
import { ensurePath } from "$lib/files"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/timing"
import { dependencies, notify, wlCopy } from "$lib/utils"
import icons from "$lib/icons"

import options from "options"

const cacheFile = `${env.paths.cache.base}/colors.json`

function loadColors() {
	const result = attempt(() => {
		const parsed: unknown = JSON.parse(readFile(cacheFile) || "[]")
		if (!Array.isArray(parsed))
			return []
		return parsed.filter(color => typeof color === "string")
	})
	if (!result.ok) {
		console.error("colorpicker.load: Failed to load saved colors", result.err)
		return []
	}
	return result.value
}

@register()
export default class ColorPicker extends GObject.Object {
	declare static $gtype: GObject.GType<ColorPicker>
	static instance: ColorPicker

	static get_default() {
		return this.instance ??= new ColorPicker()
	}

	#notificationId: number
	#colors: string[]
	#save = debounce(1000, async () => {
		const result = await attemptAsync(async () => {
			ensurePath(cacheFile)
			await writeFileAsync(cacheFile, JSON.stringify(this.#colors, null, 0))
		})
		if (!result.ok)
			console.error("colorpicker.save: Failed to save colors", result.err)
	})

	constructor() {
		super()

		ensurePath(cacheFile)
		this.#notificationId = 0
		this.#colors = loadColors()
	}

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
			const result = await attemptAsync(async () => execAsync("hyprpicker -r"))
			if (!result.ok)
				return
			color = result.value.replace("[ERR] renderSurface: PBUFFER null", "").trim()
			if (!color) return
		}

		wlCopy(color)

		if (!existing) {
			const max = options.colorpicker.maxColors.peek()
			const colors = [...this.#colors]

			if (!colors.includes(color)) {
				colors.push(color)
				if (colors.length > max) colors.shift()
				this.#colors = colors
				this.notify("colors")
				this.#save.call()
			}
		}

		notify({
			id: this.#notificationId,
			appName: "Colorpicker",
			appIcon: icons.ui.colorpicker,
			summary: "Copied to clipboard",
			body: color,
		}).then(id => {
			if (id) this.#notificationId = id
		})
	}
}
