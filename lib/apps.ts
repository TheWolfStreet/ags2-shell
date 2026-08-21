// Launches desktop applications and commands through Hyprland.

import AstalApps from "gi://AstalApps"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"

import { hyprland } from "$lib/hyprland"

export function launchApp(app: AstalApps.Application | string): void {
	if (typeof app !== "string") {
		const entry = app.get_entry()
		const desktopFile = entry
			? GioUnix.DesktopAppInfo.new(entry)?.get_filename()
			: null
		if (desktopFile)
			hyprland.message_async(
				`dispatch exec gio launch ${GLib.shell_quote(desktopFile)}`,
				null,
			)
		else app.launch()
		return
	}

	hyprland.message_async(`dispatch exec ${GLib.shell_quote(app.trim())}`, null)
}
