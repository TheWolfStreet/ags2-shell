// Starts shell styling and synchronizes wallpaper, Hyprland, GNOME, and tmux appearance.
import { execAsync } from "ags/process"
import { idle } from "ags/time"

import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"

import { beginCssBatch, endCssBatch, initCss } from "style"
import {
	buildWallpaperPalette,
	type Rgb,
	type WallpaperPalette,
} from "$lib/colors"
import env from "$lib/env"
import { attempt } from "$lib/result"
import { debounce } from "$lib/time"
import { hasProgram } from "$lib/programs"
import { getFileSize } from "$lib/textures"
import { hyprland } from "$lib/hyprland"
import { wallpaperPath, wallpaperRevision } from "$lib/wallpaper"

import options, { subscribeOptions } from "$shell/options"

const { scheme, dark, light } = options.theme
const SCHEME_SYNC_DEBOUNCE_MS = 200

const iconThemeAvailability = new Map<string, boolean>()

const settings = new Gio.Settings({
	schema: "org.gnome.desktop.interface",
})

function syncColorScheme() {
	const desired = `prefer-${scheme.peek()}`
	if (settings.get_string("color-scheme") !== desired)
		settings.set_string("color-scheme", desired)
}

function getBaseIconTheme(themeName: string): string {
	return themeName.replace(/[-_]?(dark|light)$/i, "")
}

function iconThemeExists(themeName: string): boolean {
	const cached = iconThemeAvailability.get(themeName)
	if (cached !== undefined) return cached

	const iconDirs = [
		GLib.build_filenamev([GLib.get_home_dir(), ".icons"]),
		GLib.build_filenamev([GLib.get_user_data_dir(), "icons"]),
		...GLib.get_system_data_dirs().map((dir) =>
			GLib.build_filenamev([dir, "icons"]),
		),
	]
	const available = iconDirs.some((dir) =>
		GLib.file_test(
			GLib.build_filenamev([dir, themeName, "index.theme"]),
			GLib.FileTest.EXISTS,
		),
	)

	iconThemeAvailability.set(themeName, available)
	return available
}

function syncIconTheme() {
	const currentTheme = settings.get_string("icon-theme")
	if (!currentTheme) return

	const baseTheme = getBaseIconTheme(currentTheme)
	const isDark = scheme.peek() === "dark"
	const suffixes = isDark
		? ["-dark", "-Dark", "_dark"]
		: ["-light", "-Light", "_light", ""]

	for (const suffix of suffixes) {
		const candidate = baseTheme + suffix
		if (iconThemeExists(candidate)) {
			if (currentTheme !== candidate)
				settings.set_string("icon-theme", candidate)
			return
		}
	}

	if (!isDark && iconThemeExists(baseTheme) && currentTheme !== baseTheme)
		settings.set_string("icon-theme", baseTheme)
}

async function syncTmuxAccent() {
	const hex =
		scheme.peek() === "dark" ? dark.primary.bg.peek() : light.primary.bg.peek()

	await execAsync(["tmux", "set", "-g", "@main_accent", hex]).catch(() => {})

	const rawSessions = await execAsync([
		"tmux",
		"list-sessions",
		"-F",
		"#S",
	]).catch(() => "")
	if (!rawSessions) return

	const sessions = rawSessions.split("\n").filter(Boolean)
	for (const session of sessions)
		execAsync(["tmux", "set-option", "-t", session, "@main_accent", hex]).catch(
			() => {},
		)
}

const syncScheme = debounce(SCHEME_SYNC_DEBOUNCE_MS, () => {
	syncColorScheme()
	syncIconTheme()
})

const syncTmux = debounce(60, () => syncTmuxAccent())

function startHyprlandAppearanceSync() {
	const {
		hyprland: hyprlandOptions,
		theme: {
			spacing,
			roundness,
			border: { width },
			opacity,
			blur,
			shadows,
		},
	} = options
	const darkActive = dark.primary.bg
	const lightActive = light.primary.bg
	const dependencies = [
		"hyprland",
		spacing.id,
		roundness.id,
		width.id,
		opacity.id,
		blur.id,
		shadows.id,
		darkActive.id,
		lightActive.id,
		scheme.id,
	]

	const primary = () =>
		scheme.peek() === "dark" ? darkActive.peek() : lightActive.peek()
	const rgba = (color: string) => `rgba(${color}ff)`.replace("#", "")

	const applyHyprlandAppearance = () => {
		idle(() => {
			const gaps = Math.floor(hyprlandOptions.gaps.peek() * spacing.peek())
			const rules = [
				`general:border_size ${width.peek()}`,
				`general:gaps_out ${gaps}`,
				`general:gaps_in ${Math.floor(gaps / 2)}`,
				`general:col.active_border ${rgba(primary())}`,
				`general:col.inactive_border ${rgba(hyprlandOptions.inactiveBorder.peek())}`,
				`decoration:rounding ${roundness.peek()}`,
				`decoration:shadow:enabled ${shadows.peek() ? "yes" : "no"}`,
				`decoration:blur:enabled ${blur.peek() ? "true" : "false"}`,
			]
			const batch = rules.map((rule) => `keyword ${rule}`).join("; ")
			hyprland.message(`[[BATCH]]/${batch}`)
		})
	}

	const update = debounce(100, applyHyprlandAppearance)
	hyprland.connect("config-reloaded", () => update.call())
	subscribeOptions(options, dependencies, () => update.call())
	update.call()
}

const SAMPLE_SIZE = 96
const WALLPAPER_THEME_DELAY_MS = 180
let lastWallpaperRevision = -1

function sampleWallpaperPixels(path: string): Rgb[] {
	const animation = GdkPixbuf.PixbufAnimation.new_from_file(path)
	const source = animation.get_static_image()
	const pixbuf =
		source.scale_simple(
			SAMPLE_SIZE,
			SAMPLE_SIZE,
			GdkPixbuf.InterpType.BILINEAR,
		) ?? source
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

function applyWallpaperPalette(colors: WallpaperPalette) {
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

const updateWallpaperTheme = debounce(WALLPAPER_THEME_DELAY_MS, () => {
	if (!options.autotheme.peek()) return
	const path = wallpaperPath
	if (!getFileSize(path)) return
	const revision = wallpaperRevision.peek()
	if (revision === lastWallpaperRevision) return

	const result = attempt(() =>
		buildWallpaperPalette(sampleWallpaperPixels(path)),
	)
	if (!result.ok) {
		console.error("wallpaper.theme: Failed to sample wallpaper", result.err)
		return
	}
	if (!result.value) {
		console.error("wallpaper.theme: Wallpaper contained no usable pixels")
		return
	}

	applyWallpaperPalette(result.value)
	lastWallpaperRevision = revision
})

function startWallpaperTheme() {
	wallpaperRevision.subscribe(() => updateWallpaperTheme.call())
	options.autotheme.subscribe(() => {
		if (options.autotheme.peek()) {
			lastWallpaperRevision = -1
			updateWallpaperTheme.call()
		} else {
			updateWallpaperTheme.cancel()
		}
	})
	updateWallpaperTheme.call()
}

export default async function startShell() {
	env.init()
	initCss()

	syncColorScheme()
	syncIconTheme()
	scheme.subscribe(() => syncScheme.call())

	if (hasProgram("tmux")) {
		syncTmuxAccent()
		options.theme.dark.primary.bg.subscribe(() => syncTmux.call())
		options.theme.light.primary.bg.subscribe(() => syncTmux.call())
		options.theme.scheme.subscribe(() => syncTmux.call())
	}

	startWallpaperTheme()
	startHyprlandAppearanceSync()
}
