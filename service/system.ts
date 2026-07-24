// Starts system services and hides known Hyprland startup warnings.

import Media from "gi://AstalMpris"
import Hyprland from "gi://AstalHyprland"
import Battery from "gi://AstalBattery"
import Tray from "gi://AstalTray"
import Audio from "gi://AstalWp"
import PowerProfiles from "gi://AstalPowerProfiles"
import Notifd from "gi://AstalNotifd"
import Bluetooth from "gi://AstalBluetooth"
import Network from "gi://AstalNetwork"
import GLib from "gi://GLib"

function createHyprland() {
	const critical = GLib.LogLevelFlags.LEVEL_CRITICAL
	const knownMessages = [
		"json_node_get_string: assertion 'JSON_NODE_IS_VALID (node)' failed",
		"astal_hyprland_hyprland_get_client: assertion 'address != NULL' failed",
	]
	const ignoreEmptyFocus = (domain: string | null, level: GLib.LogLevelFlags, message: string) => {
		if (!knownMessages.some(known => message.includes(known)))
			GLib.log_default_handler(domain, level, message, null)
	}
	const jsonHandler = GLib.log_set_handler("Json", critical, ignoreEmptyFocus)
	const defaultHandler = GLib.log_set_handler("", critical, ignoreEmptyFocus)

	try {
		return Hyprland.get_default()
	} finally {
		GLib.log_remove_handler("Json", jsonHandler)
		GLib.log_remove_handler("", defaultHandler)
	}
}

export const media = Media.get_default()
export const hyprland = createHyprland()
export const battery = Battery.get_default()
export const tray = Tray.get_default()
export const audio = Audio.get_default()
export const powerProfiles = PowerProfiles.get_default()
export const notificationDaemon = Notifd.get_default()
export const bluetooth = Bluetooth.get_default()
export const network = Network.get_default()
