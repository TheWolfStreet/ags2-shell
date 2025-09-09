import { execAsync } from "ags/process"

import Gio from "gi://Gio"

import { bash } from "$lib/utils"
import hyprinit from "$lib/hyprland"
import { env } from "./env"
import { Matugen } from "./matugen"
import { initCss } from "style"

import options from "options"

const { scheme, dark, light } = options.theme

const settings = new Gio.Settings({
	schema: "org.gnome.desktop.interface",
})

function gtk() {
	const desired = `prefer-${scheme.get()}`;
	if (settings.get_string("color-scheme") !== desired) {
		settings.set_string("color-scheme", desired);
	}
}

async function tmux() {
	const hex =
		scheme.get() === "dark" ? dark.primary.bg.get() : light.primary.bg.get()

	await bash(`tmux set -g @main_accent "${hex}"`).catch(() => { })

	const rawSessions = await bash(`tmux list-sessions -F "#S"`).catch(() => "")
	if (!rawSessions) return

	const sessions = rawSessions.split("\n").filter(Boolean)
	for (const session of sessions) {
		bash(`tmux set-option -t ${session} @main_accent "${hex}"`).catch(() => { })
	}
}

export default async function init() {
	gtk()
	scheme.subscribe(gtk)

	const tmuxPresent = await execAsync("which tmux").then(() => true).catch(() => false)
	if (tmuxPresent) {
		tmux()
		options.theme.dark.primary.bg.subscribe(tmux)
		options.theme.light.primary.bg.subscribe(tmux)
		options.theme.scheme.subscribe(tmux)
	}

	env.init()
	Matugen.init()
	hyprinit()
	initCss()
}
