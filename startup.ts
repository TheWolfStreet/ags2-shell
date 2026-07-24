// Starts shell styling and synchronizes wallpaper, Hyprland, GNOME, and tmux appearance.
import { execAsync } from "ags/process"
import { idle } from "ags/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { initCss } from "style"
import env from "$lib/env"
import { subscribeOptions } from "$lib/option"
import { debounce } from "$lib/timing"
import { hasProgram } from "$lib/programs"
import { hyprland } from "$service/astal"
import { startWallpaperTheme } from "widget/Wallpaper/theme"

import options from "options"

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
	if (cached !== undefined)
		return cached

	const iconDirs = [
		GLib.build_filenamev([GLib.get_home_dir(), ".icons"]),
		GLib.build_filenamev([GLib.get_user_data_dir(), "icons"]),
		...GLib.get_system_data_dirs().map(dir => GLib.build_filenamev([dir, "icons"])),
	]
	const available = iconDirs.some(dir =>
		GLib.file_test(GLib.build_filenamev([dir, themeName, "index.theme"]), GLib.FileTest.EXISTS),
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
	const hex = scheme.peek() === "dark" ? dark.primary.bg.peek() : light.primary.bg.peek()

	await execAsync(["tmux", "set", "-g", "@main_accent", hex]).catch(() => { })

	const rawSessions = await execAsync(["tmux", "list-sessions", "-F", "#S"]).catch(() => "")
	if (!rawSessions) return

	const sessions = rawSessions.split("\n").filter(Boolean)
	for (const session of sessions)
		execAsync(["tmux", "set-option", "-t", session, "@main_accent", hex]).catch(() => { })
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

	const primary = () => scheme.peek() === "dark" ? darkActive.peek() : lightActive.peek()
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
			const batch = rules.map(rule => `keyword ${rule}`).join("; ")
			hyprland.message(`[[BATCH]]/${batch}`)
		})
	}

	const update = debounce(100, applyHyprlandAppearance)
	hyprland.connect("config-reloaded", () => update.call())
	subscribeOptions(options, dependencies, () => update.call())
	update.call()
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
