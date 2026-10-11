import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"

import { attempt, log_error } from "$lib/result"

function create_hyprland() {
	const critical = GLib.LogLevelFlags.LEVEL_CRITICAL
	const known_messages = [
		"json_node_get_string: assertion 'JSON_NODE_IS_VALID (node)' failed",
		"astal_hyprland_hyprland_get_client: assertion 'address != NULL' failed",
	]
	const ignore_known_warnings = (
		domain: string | null,
		level: GLib.LogLevelFlags,
		message: string,
	) => {
		if (!known_messages.some((known) => message.includes(known)))
			GLib.log_default_handler(domain, level, message, null)
	}
	const json_handler = GLib.log_set_handler(
		"Json",
		critical,
		ignore_known_warnings,
	)
	const default_handler = GLib.log_set_handler(
		"",
		critical,
		ignore_known_warnings,
	)

	try {
		return Hyprland.get_default()
	} finally {
		GLib.log_remove_handler("Json", json_handler)
		GLib.log_remove_handler("", default_handler)
	}
}

export const hyprland = create_hyprland()

export function live_monitor_names(): Set<string> {
	const queried = attempt(() => {
		const monitors: unknown = JSON.parse(hyprland.message("j/monitors"))
		if (!Array.isArray(monitors)) throw new Error("Unexpected monitor reply")
		return monitors
			.map((monitor: { name?: unknown }) => monitor.name)
			.filter((name): name is string => typeof name === "string")
	})
	if (log_error(queried, "hyprland.monitors: Failed to query monitors"))
		return new Set(queried.value)
	return new Set(
		hyprland.monitors
			.map((monitor) => monitor?.name)
			.filter((name): name is string => typeof name === "string"),
	)
}
