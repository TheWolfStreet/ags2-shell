// Checks for commands, copies text, and starts applications through Hyprland.

import Apps from "gi://AstalApps"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import icons from "$lib/icons"
import { notify } from "$lib/notifications"
import { hyprland } from "$service/system"

export async function wlCopy(data: string) {
	if (!requirePrograms("wl-copy")) return ""

	return new Promise<void>((resolve, reject) => {
		const process = Gio.Subprocess.new(["wl-copy"], Gio.SubprocessFlags.STDIN_PIPE)
		process.communicate_utf8_async(data, null, (_, result) => {
			try {
				process.communicate_utf8_finish(result)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	})
}

const dependencyCache = new Map<string, boolean>()

export function hasProgram(name: string) {
	let found = dependencyCache.get(name)
	if (found === undefined) {
		found = GLib.find_program_in_path(name) !== null
		dependencyCache.set(name, found)
	}
	return found
}

export function requirePrograms(...bins: string[]) {
	const missing = bins.filter(bin => !hasProgram(bin))

	if (missing.length > 0) {
		console.warn(`Missing dependencies: ${missing.join(", ")}`)
		notify({ appIcon: icons.missing, appName: "Error", summary: "Missing dependencies", body: `Could not locate ${missing.join(", ")}`, urgency: "critical" })
	}

	return missing.length === 0
}

export function launchApp(app: Apps.Application | string) {
	let executable: string
	if (typeof app === "string") {
		executable = app.trim()
	} else {
		executable = app.executable
			.split(/\s+/)
			.filter(part => !part.startsWith("%") && !part.startsWith("@"))
			.join(" ")
			.trim()
	}

	hyprland.message_async(`dispatch exec '${executable}'`, null)
}
