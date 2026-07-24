// Loads styles, wallpaper colors, Hyprland settings, and GNOME appearance settings.
import { execAsync } from "ags/process"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { initCss } from "style"
import env from "$lib/env"
import hyprinit from "$lib/hyprland"
import { debounce } from "./timing"
import { WallpaperColors } from "./palette"
import { hasProgram } from "./programs"

import options from "options"

const { scheme, dark, light } = options.theme
const SCHEME_SYNC_DEBOUNCE_MS = 200
const REMOVED_GTK_THEME = "ags2-shell"
const GTK_EXPORT_MARKERS = [
	"/* ags2-shell: managed */",
	"/* ags2-shell: gtk4-override */",
]

const iconThemeAvailability = new Map<string, boolean>()

const settings = new Gio.Settings({
	schema: "org.gnome.desktop.interface",
})

// One-time idempotent cleanup for the removed shipped GTK export behavior.
function cleanupRemovedGtkExports() {
	const configDir = GLib.get_user_config_dir()
	for (const version of ["gtk-3.0", "gtk-4.0"]) {
		for (const name of ["gtk.css", "gtk-dark.css"]) {
			const path = GLib.build_filenamev([configDir, version, name])
			try {
				const [ok, bytes] = GLib.file_get_contents(path)
				if (ok && GTK_EXPORT_MARKERS.some(marker => new TextDecoder().decode(bytes).startsWith(marker)))
					GLib.unlink(path)
			} catch { }
		}
	}

	const themePath = GLib.build_filenamev([GLib.get_user_data_dir(), "themes", REMOVED_GTK_THEME])
	const indexPath = GLib.build_filenamev([themePath, "index.theme"])
	try {
		const [hasIndex, bytes] = GLib.file_test(indexPath, GLib.FileTest.EXISTS)
			? GLib.file_get_contents(indexPath)
			: [false, new Uint8Array()]
		const index = hasIndex ? new TextDecoder().decode(bytes) : ""
		if (index.includes("Name=ags2-shell") && index.includes("Comment=ags2-shell GTK theme")) {
			for (const relativePath of [
				"index.theme",
				"gtk-4.0/gtk.css",
				"gtk-4.0/gtk-dark.css",
				"gtk-3.0/gtk.css",
				"gtk-3.0/gtk-dark.css",
			]) {
				try { GLib.unlink(GLib.build_filenamev([themePath, relativePath])) } catch { }
			}

			// Non-empty directories are preserved in case the user added anything.
			for (const relativePath of ["gtk-4.0", "gtk-3.0", ""]) {
				try { Gio.File.new_for_path(GLib.build_filenamev([themePath, relativePath])).delete(null) } catch { }
			}
		}
	} catch (error) {
		console.error("init.gtkExportCleanup: Failed to remove old managed theme", error)
	}

	const previousThemePath = `${env.paths.cache.base}/prev-gtk-theme`
	if (settings.get_string("gtk-theme") === REMOVED_GTK_THEME) {
		let previousTheme = ""
		try {
			const [ok, bytes] = GLib.file_get_contents(previousThemePath)
			previousTheme = ok ? new TextDecoder().decode(bytes).trim() : ""
		} catch { }
		settings.set_string("gtk-theme", previousTheme || "Adwaita")
	}
	try { GLib.unlink(previousThemePath) } catch { }
}

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

export default async function init() {
	env.init()
	cleanupRemovedGtkExports()
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

	WallpaperColors.init()
	hyprinit()
}
