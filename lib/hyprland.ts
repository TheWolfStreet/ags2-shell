// Initializes Hyprland while suppressing known transient Astal startup warnings.

import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"

function createHyprland() {
	const critical = GLib.LogLevelFlags.LEVEL_CRITICAL
	const knownMessages = [
		"json_node_get_string: assertion 'JSON_NODE_IS_VALID (node)' failed",
		"astal_hyprland_hyprland_get_client: assertion 'address != NULL' failed",
	]
	const ignoreKnownWarnings = (
		domain: string | null,
		level: GLib.LogLevelFlags,
		message: string,
	) => {
		if (!knownMessages.some((known) => message.includes(known)))
			GLib.log_default_handler(domain, level, message, null)
	}
	const jsonHandler = GLib.log_set_handler(
		"Json",
		critical,
		ignoreKnownWarnings,
	)
	const defaultHandler = GLib.log_set_handler("", critical, ignoreKnownWarnings)

	try {
		return Hyprland.get_default()
	} finally {
		GLib.log_remove_handler("Json", jsonHandler)
		GLib.log_remove_handler("", defaultHandler)
	}
}

export const hyprland = createHyprland()
