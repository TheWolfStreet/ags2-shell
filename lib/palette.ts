// Reads the first wallpaper frame and updates colors when automatic theming is on.

import app from "ags/gtk4/app"
import { debounce } from "$lib/timing"

import GdkPixbuf from "gi://GdkPixbuf"
import Gio from "gi://Gio"

import { buildWallpaperPalette, type Rgb, type WallpaperPalette } from "$lib/color"
import { getFileSize } from "$lib/textures"
import { attempt } from "$lib/result"
import { beginCssBatch, endCssBatch } from "style"
import { wallpaper } from "widget/Wallpaper"

import options from "options"

const SAMPLE_SIZE = 96
const UPDATE_DELAY_MS = 180

export namespace WallpaperColors {
	let initialized = false
	let wallpaperHandlerId: number | null = null
	let disposeAutothemeSubscription: (() => void) | null = null
	let lastSignature = ""

	function fileSignature(path: string) {
		const result = attempt(() => {
			const info = Gio.File.new_for_path(path).query_info(
				"standard::size,time::modified,time::modified-usec",
				Gio.FileQueryInfoFlags.NONE,
				null,
			)
			return `${path}:${info.get_size()}:${info.get_attribute_uint64("time::modified")}:${info.get_attribute_uint32("time::modified-usec")}`
		})
		return result.ok ? result.value : ""
	}

	function samplePixels(path: string): Rgb[] {
		const animation = GdkPixbuf.PixbufAnimation.new_from_file(path)
		const source = animation.get_static_image()
		const pixbuf = source.scale_simple(SAMPLE_SIZE, SAMPLE_SIZE, GdkPixbuf.InterpType.BILINEAR) ?? source
		const pixels = pixbuf.get_pixels()
		const width = pixbuf.get_width()
		const height = pixbuf.get_height()
		const rowstride = pixbuf.get_rowstride()
		const channels = pixbuf.get_n_channels()
		const hasAlpha = pixbuf.get_has_alpha()
		const samples: Rgb[] = []

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const offset = y * rowstride + x * channels
				if (hasAlpha && pixels[offset + 3] < 32) continue
				samples.push({
					r: pixels[offset] / 255,
					g: pixels[offset + 1] / 255,
					b: pixels[offset + 2] / 255,
				})
			}
		}

		return samples
	}

	export function generate(path: string): WallpaperPalette | null {
		return buildWallpaperPalette(samplePixels(path))
	}

	function apply(colors: WallpaperPalette) {
		const { dark, light } = options.theme
		beginCssBatch()
		try {
			dark.bg.set(colors.dark.bg)
			dark.fg.set(colors.dark.fg)
			dark.widget.set(colors.dark.widget)
			dark.border.set(colors.dark.border)
			dark.primary.bg.set(colors.dark.primaryBg)
			dark.primary.fg.set(colors.dark.primaryFg)
			dark.error.bg.set(colors.dark.errorBg)
			light.bg.set(colors.light.bg)
			light.fg.set(colors.light.fg)
			light.widget.set(colors.light.widget)
			light.border.set(colors.light.border)
			light.primary.bg.set(colors.light.primaryBg)
			light.primary.fg.set(colors.light.primaryFg)
			light.error.bg.set(colors.light.errorBg)
		} finally {
			endCssBatch()
		}
	}

	const update = debounce(UPDATE_DELAY_MS, () => {
		if (!options.autotheme.peek()) return
		const path = wallpaper.wallpaper
		if (!getFileSize(path)) return
		const signature = fileSignature(path)
		if (!signature || signature === lastSignature) return

		const result = attempt(() => generate(path))
		if (!result.ok) {
			console.error("palette.generate: Failed to sample wallpaper", result.err)
			return
		}
		if (!result.value) {
			console.error("palette.generate: Wallpaper contained no usable pixels")
			return
		}

		apply(result.value)
		lastSignature = signature
	})

	function dispose() {
		if (wallpaperHandlerId !== null) {
			wallpaper.disconnect(wallpaperHandlerId)
			wallpaperHandlerId = null
		}
		disposeAutothemeSubscription?.()
		disposeAutothemeSubscription = null
		update.cancel()
		initialized = false
	}

	export function init() {
		if (initialized) return
		initialized = true
		wallpaperHandlerId = wallpaper.connect("notify::wallpaper", () => {
			lastSignature = ""
			update.call()
		})
		disposeAutothemeSubscription = options.autotheme.subscribe(() => {
			lastSignature = ""
			if (options.autotheme.peek()) update.call()
			else update.cancel()
		})
		app.connect("shutdown", dispose)
		update.call()
	}
}
