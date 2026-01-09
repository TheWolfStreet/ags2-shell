import { execAsync } from "ags/process"

import Gio from "gi://Gio"

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
	scheme.subscribe(gtk)

	const tmuxPresent = await execAsync("which tmux").then(() => true).catch(() => false)
	if (tmuxPresent) {
		tmux()
		options.theme.dark.primary.bg.subscribe(tmux)
		options.theme.light.primary.bg.subscribe(tmux)
		options.theme.scheme.subscribe(tmux)
	}

	Matugen.init()
	hyprinit()

	function syncDockPosition() {
		const barPos = options.bar.position.peek()
		const dockPos = barPos === "bottom" ? "top" : "bottom"
		options.dock.position.set(dockPos)
	}

	syncDockPosition()
	options.bar.position.subscribe(syncDockPosition)

	initCss()
}
