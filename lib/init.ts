import { execAsync } from "ags/process"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { initCss } from "style"
import env from "$lib/env"
import hyprinit from "$lib/hyprland"
import { attempt } from "$lib/result"
import { debounce } from "./timing"
import { Matugen } from "./matugen"

import options from "options"

const { scheme, dark, light, exportGtk } = options.theme

const GTK_THEME_NAME = "ags2-shell"
const PREV_GTK_THEME_PATH = `${env.paths.cache.base}/prev-gtk-theme`
const GTK_SYNC_DEBOUNCE_MS = 200

let lastGtkPreferDark: string | null = null

const iconThemeAvailability = new Map<string, boolean>()
const pendingGtkUpdates = new Set<"scheme" | "export">()

const settings = new Gio.Settings({
	schema: "org.gnome.desktop.interface",
})

function gtk() {
	const desired = `prefer-${scheme.peek()}`
	if (settings.get_string("color-scheme") !== desired) {
		settings.set_string("color-scheme", desired)
	}
}

function applyGtkTheme() {
	const currentTheme = settings.get_string("gtk-theme")
	if (exportGtk.peek()) {
		if (currentTheme !== GTK_THEME_NAME) {
			storePreviousGtkTheme(currentTheme)
			settings.set_string("gtk-theme", GTK_THEME_NAME)
		}
		return
	}

	if (currentTheme === GTK_THEME_NAME) {
		const previous = readPreviousGtkTheme()
		if (previous && previous !== GTK_THEME_NAME) {
			settings.set_string("gtk-theme", previous)
		}
	}
}

function storePreviousGtkTheme(themeName: string) {
	if (!themeName || themeName === GTK_THEME_NAME) return
	const result = attempt(() => {
		const file = Gio.File.new_for_path(PREV_GTK_THEME_PATH)
		file.replace_contents(themeName, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null)
	})
	if (!result.ok)
		console.error("init.storePreviousGtkTheme: Failed to store previous GTK theme", result.err)
}

function readPreviousGtkTheme(): string | null {
	const result = attempt(() => {
		const file = Gio.File.new_for_path(PREV_GTK_THEME_PATH)
		const [ok, bytes] = file.load_contents(null)
		if (!ok || !bytes) return null
		return new TextDecoder().decode(bytes).trim()
	})
	return result.ok ? result.value : null
}

function writeGtkPreference() {
	if (!exportGtk.peek()) {
		lastGtkPreferDark = null
		return
	}

	const preferDark = scheme.peek() === "dark"
	const gtkPref = preferDark ? "1" : "0"
	if (lastGtkPreferDark === gtkPref)
		return

	lastGtkPreferDark = gtkPref

	const configDir = GLib.get_user_config_dir()
	const targets = [
		GLib.build_filenamev([configDir, "gtk-3.0", "settings.ini"]),
	]

	for (const filePath of targets) {
		try {
			const file = Gio.File.new_for_path(filePath)
			const [ok, bytes] = file.load_contents(null)
			if (!ok || !bytes) continue
			const text = new TextDecoder().decode(bytes)
			const lines = text.split("\n")
			const idx = lines.findIndex(line => line.startsWith("gtk-application-prefer-dark-theme"))
			if (idx >= 0) {
				if (lines[idx] === `gtk-application-prefer-dark-theme=${gtkPref}`)
					continue
				lines[idx] = `gtk-application-prefer-dark-theme=${gtkPref}`
			} else {
				lines.push(`gtk-application-prefer-dark-theme=${gtkPref}`)
			}
			file.replace_contents(lines.join("\n"), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null)
		} catch (e) {
			lastGtkPreferDark = null
			console.error("init.writeGtkPreference: Failed to write GTK preference", e)
		}
	}
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

function iconTheme() {
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
			if (currentTheme !== candidate) {
				settings.set_string("icon-theme", candidate)
			}
			return
		}
	}

	if (!isDark && iconThemeExists(baseTheme) && currentTheme !== baseTheme) {
		settings.set_string("icon-theme", baseTheme)
	}
}

async function tmux() {
	const hex =
		scheme.peek() === "dark" ? dark.primary.bg.peek() : light.primary.bg.peek()

	await execAsync(["tmux", "set", "-g", "@main_accent", hex]).catch(() => { })

	const rawSessions = await execAsync(["tmux", "list-sessions", "-F", "#S"]).catch(() => "")
	if (!rawSessions) return

	const sessions = rawSessions.split("\n").filter(Boolean)
	for (const session of sessions) {
		execAsync(["tmux", "set-option", "-t", session, "@main_accent", hex]).catch(() => { })
	}
}

const gtkUpdate = debounce(GTK_SYNC_DEBOUNCE_MS, () => {
	const schemeChanged = pendingGtkUpdates.has("scheme")
	const any = pendingGtkUpdates.size > 0
	pendingGtkUpdates.clear()

	if (schemeChanged) {
		gtk()
		writeGtkPreference()
		iconTheme()
	}

	if (any) {
		applyGtkTheme()
	}
})

const tmuxUpdate = debounce(60, () => tmux())

function scheduleSchemeUpdate() {
	pendingGtkUpdates.add("scheme")
	gtkUpdate.call()
}

function scheduleExportUpdate() {
	pendingGtkUpdates.add("export")
	gtkUpdate.call()
}

function scheduleTmuxUpdate() {
	tmuxUpdate.call()
}

export default async function init() {
	env.init()

	gtk()
	writeGtkPreference()
	applyGtkTheme()
	iconTheme()
	scheme.subscribe(scheduleSchemeUpdate)
	exportGtk.subscribe(scheduleExportUpdate)

	const tmuxPresent = await execAsync("which tmux").then(() => true).catch(() => false)
	if (tmuxPresent) {
		tmux()
		options.theme.dark.primary.bg.subscribe(scheduleTmuxUpdate)
		options.theme.light.primary.bg.subscribe(scheduleTmuxUpdate)
		options.theme.scheme.subscribe(scheduleTmuxUpdate)
	}

	Matugen.init()
	hyprinit()

	initCss()
}
