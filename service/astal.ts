// Exposes shared Astal services and hides known Hyprland startup warnings.

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
import Gio from "gi://Gio"

import { attempt } from "$lib/result"

const critical = GLib.LogLevelFlags.LEVEL_CRITICAL
const MPRIS_ART_CACHE_DIR = `${GLib.get_user_cache_dir()}/astal/mpris`
const inlineMprisArtWrites = new Set<string>()

// NOTE: Pinned Astal cannot copy MPRIS data URIs, so avoid its payload dump and pre-cache them in application code.
GLib.log_set_handler("", critical, (domain, level, message) => {
	if (message.includes("Failed to cache cover art with url \"data:image/")) return
	GLib.log_default_handler(domain, level, message, null)
})

function cacheInlineMprisArt(uri: string) {
	if (!uri.startsWith("data:image/") || !uri.includes(";base64,")) return

	const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, uri, -1)
	const cachePath = `${MPRIS_ART_CACHE_DIR}/${hash}`
	if (inlineMprisArtWrites.has(cachePath) || GLib.file_test(cachePath, GLib.FileTest.EXISTS)) return

	const decoded = attempt(() => GLib.base64_decode(uri.slice(uri.indexOf(",") + 1).replace(/\s/g, "")))
	if (!decoded.ok) {
		console.error("textures.inlineMprisArt: Failed to decode artwork", decoded.err)
		return
	}

	GLib.mkdir_with_parents(MPRIS_ART_CACHE_DIR, 0o755)
	inlineMprisArtWrites.add(cachePath)
	const target = Gio.File.new_for_path(cachePath)
	target.replace_contents_async(decoded.value, null, false, Gio.FileCreateFlags.NONE, null, (_file, result) => {
		const written = attempt(() => target.replace_contents_finish(result))
		inlineMprisArtWrites.delete(cachePath)
		if (!written.ok)
			console.error("textures.inlineMprisArt: Failed to cache artwork", written.err)
	})
}

function createMedia() {
	const instance = Media.get_default()
	const handlers = new WeakMap<Media.Player, number>()
	const watch = (player: Media.Player) => {
		if (handlers.has(player)) return
		cacheInlineMprisArt(player.get_art_url())
		handlers.set(player, player.connect("notify::art-url", () => cacheInlineMprisArt(player.get_art_url())))
	}
	const unwatch = (player: Media.Player) => {
		const handler = handlers.get(player)
		if (handler) player.disconnect(handler)
		handlers.delete(player)
	}

	for (const player of instance.get_players()) watch(player)
	instance.connect("player-added", (_media, player) => watch(player))
	instance.connect("player-closed", (_media, player) => unwatch(player))
	return instance
}

function createHyprland() {
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

export const media = createMedia()
export const hyprland = createHyprland()
export const battery = Battery.get_default()
export const tray = Tray.get_default()
export const audio = Audio.get_default()
export const powerProfiles = PowerProfiles.get_default()
export const notificationDaemon = Notifd.get_default()
export const bluetooth = Bluetooth.get_default()
export const network = Network.get_default()
