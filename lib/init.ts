import { execAsync } from "ags/process"

import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"

import { bash } from "$lib/utils"
import { initCss } from "style"
import env from "$lib/env"
import hyprinit from "$lib/hyprland"
import { Matugen } from "./matugen"

import options from "options"

const { scheme, dark, light } = options.theme

const settings = new Gio.Settings({
	schema: "org.gnome.desktop.interface",
})

function gtk() {
	const desired = `prefer-${scheme.peek()}`;
	if (settings.get_string("color-scheme") !== desired) {
		settings.set_string("color-scheme", desired);
	}
}

function getBaseIconTheme(themeName: string): string {
	return themeName.replace(/[-_]?(dark|light)$/i, "")
}

function iconThemeExists(themeName: string): boolean {
	const theme = new Gtk.IconTheme({ themeName })
	return theme.has_icon("folder")
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

	await bash(`tmux set -g @main_accent "${hex}"`).catch(() => { })

	const rawSessions = await bash(`tmux list-sessions -F "#S"`).catch(() => "")
	if (!rawSessions) return

	const sessions = rawSessions.split("\n").filter(Boolean)
	for (const session of sessions) {
		bash(`tmux set-option -t ${session} @main_accent "${hex}"`).catch(() => { })
	}
}

export default async function init() {
	env.init()

	gtk()
	iconTheme()
	scheme.subscribe(gtk)
	scheme.subscribe(iconTheme)

	const tmuxPresent = await execAsync("which tmux").then(() => true).catch(() => false)
	if (tmuxPresent) {
		tmux()
		options.theme.dark.primary.bg.subscribe(tmux)
		options.theme.light.primary.bg.subscribe(tmux)
		options.theme.scheme.subscribe(tmux)
	}

	Matugen.init()
	hyprinit()

	initCss()
}
