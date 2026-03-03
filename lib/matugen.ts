import { execAsync } from "ags/process"

import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"

import { wp } from "./services"
import { attempt, attemptAsync } from "./result"
import { debounce } from "./timing"
import { dependencies } from "./utils"
import { getFileSize } from "./textures"
import { beginCssBatch, endCssBatch } from "style"

import options from "options"

export namespace Matugen {
	let matugenRequestSerial = 0
	let lastAppliedInputKey = ""
	let pendingType: "image" | "color" = "image"
	let pendingArg = ""

	const MATUGEN_DEBOUNCE_MS = 220
	const AVG_COLOR_CACHE_LIMIT = 24
	const avgColorCache = new Map<string, string>()

	type MatugenColorSwatch = { color: string }
	type MatugenColorValue = {
		light: MatugenColorSwatch
		dark: MatugenColorSwatch
		default: MatugenColorSwatch
	}

	type Colors = Record<string, MatugenColorValue>

	function parseMatugenJson(raw: string): { colors?: Colors } | null {
		const text = raw.trim()
		if (!text) return null
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		if (start < 0 || end <= start) return null
		const result = attempt(() => JSON.parse(text.slice(start, end + 1)) as { colors?: Colors })
		return result.ok ? result.value : null
	}

	function avgColorHex(filePath: string): string | null {
		const result = attempt(() => {
			const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(filePath, 64, 64, true)
			if (!pixbuf) return null
			if (!pixbuf.get_width() || !pixbuf.get_height()) return null

			const pixels = pixbuf.get_pixels()
			const rowstride = pixbuf.get_rowstride()
			const nChannels = pixbuf.get_n_channels()
			const hasAlpha = pixbuf.get_has_alpha()
			const width = pixbuf.get_width()
			const height = pixbuf.get_height()

			let r = 0
			let g = 0
			let b = 0
			let count = 0

			const step = Math.max(1, Math.floor(Math.min(width, height) / 32))
			for (let y = 0; y < height; y += step) {
				for (let x = 0; x < width; x += step) {
					const i = y * rowstride + x * nChannels
					const a = hasAlpha ? pixels[i + 3] : 255
					if (a < 16) continue
					r += pixels[i + 0]
					g += pixels[i + 1]
					b += pixels[i + 2]
					count++
				}
			}

			if (!count) return null
			const rr = Math.round(r / count)
			const gg = Math.round(g / count)
			const bb = Math.round(b / count)
			return `#${[rr, gg, bb].map(v => v.toString(16).padStart(2, "0")).join("")}`
		})
		return result.ok ? result.value : null
	}

	function rememberAverageColor(signature: string, color: string) {
		if (avgColorCache.has(signature)) {
			avgColorCache.delete(signature)
		}

		avgColorCache.set(signature, color)

		if (avgColorCache.size > AVG_COLOR_CACHE_LIMIT) {
			const oldest = avgColorCache.keys().next().value
			if (oldest) {
				avgColorCache.delete(oldest)
			}
		}
	}

	function imageSignature(filePath: string): string | null {
		if (!filePath)
			return null

		const result = attempt(() => {
			const file = Gio.File.new_for_path(filePath)
			const info = file.query_info(
				"standard::size,time::modified",
				Gio.FileQueryInfoFlags.NONE,
				null,
			)

			return `${filePath}:${info.get_size()}:${info.get_attribute_uint64("time::modified")}`
		})
		return result.ok ? result.value : null
	}

	function getAverageColorForImage(filePath: string) {
		const signature = imageSignature(filePath)
		if (!signature)
			return null

		const cached = avgColorCache.get(signature)
		if (cached) {
			return {
				signature,
				color: cached,
			}
		}

		const color = avgColorHex(filePath)
		if (!color)
			return null

		rememberAverageColor(signature, color)
		return {
			signature,
			color,
		}
	}

	export async function init() {
		wp.connect("notify::wallpaper", () => {
			lastAppliedInputKey = ""
			void getColors().catch(error => {
				console.error("matugen.getColors: Matugen color generation failed", error)
			})
		})
		options.autotheme.subscribe(() => {
			if (!options.autotheme.peek()) {
				lastAppliedInputKey = ""
				return
			}

			void getColors().catch(error => {
				console.error("matugen.getColors: Matugen color generation failed", error)
			})
		})
	}

	const runMatugen = debounce(MATUGEN_DEBOUNCE_MS, async () => {
			const requestSerial = matugenRequestSerial
			const type = pendingType
			const arg = pendingArg
			const result = await attemptAsync(async () => {
				const { scheme, dark, light } = options.theme

				let sourceColor = arg
				let inputKey = `${type}:${arg}`
				if (type === "image") {
					const sampled = getAverageColorForImage(arg)
					sourceColor = sampled?.color
						|| (scheme.peek() === "dark" ? dark.primary.bg.peek() : light.primary.bg.peek())
						|| "#777777"
					inputKey = `image:${sampled?.signature ?? arg}:${sourceColor}`
				} else {
					inputKey = `color:${sourceColor}`
				}

				if (inputKey === lastAppliedInputKey)
					return

				const out = await execAsync(["matugen", "color", "hex", sourceColor, "-j", "hex", "--dry-run", "--quiet"])
				if (requestSerial !== matugenRequestSerial)
					return

				const parsed = parseMatugenJson(out)
				const c = parsed?.colors
				if (!c) {
					console.error("matugen.getColors: Matugen produced no JSON output")
					return
				}

				beginCssBatch()
				try {
					dark.widget.set(c.on_surface.dark.color)
					light.widget.set(c.on_surface.light.color)
					dark.border.set(c.outline.dark.color)
					light.border.set(c.outline.light.color)
					dark.bg.set(c.surface.dark.color)
					light.bg.set(c.surface.light.color)
					dark.fg.set(c.on_surface.dark.color)
					light.fg.set(c.on_surface.light.color)
					dark.primary.bg.set(c.primary.dark.color)
					light.primary.bg.set(c.primary.light.color)
					dark.primary.fg.set(c.on_primary.dark.color)
					light.primary.fg.set(c.on_primary.light.color)
					dark.error.bg.set(c.error.dark.color)
					light.error.bg.set(c.error.light.color)
					dark.error.fg.set(c.on_error.dark.color)
					light.error.fg.set(c.on_error.light.color)
				} finally {
					endCssBatch()
				}

				lastAppliedInputKey = inputKey
			})
			if (!result.ok)
				console.error("matugen.getColors: Matugen color generation failed", result.err)
	})

	export async function getColors(
		type: "image" | "color" = "image",
		arg = wp.wallpaper,
	) {
		if (!options.autotheme.peek() || !dependencies("matugen")) return
		if (type === "image" && !getFileSize(arg)) return

		pendingType = type
		pendingArg = arg
		matugenRequestSerial++
		runMatugen.call()
	}
}
