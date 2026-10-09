import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"

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
