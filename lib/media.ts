// Initializes MPRIS and caches inline artwork unsupported by the pinned Astal version.

import Media from "gi://AstalMpris"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt } from "$lib/result"

const critical = GLib.LogLevelFlags.LEVEL_CRITICAL
const cacheDirectory = `${GLib.get_user_cache_dir()}/astal/mpris`
const pendingWrites = new Set<string>()

GLib.log_set_handler("", critical, (domain, level, message) => {
	if (message.includes('Failed to cache cover art with url "data:image/'))
		return
	GLib.log_default_handler(domain, level, message, null)
})

function cacheInlineArtwork(uri: string): void {
	if (!uri.startsWith("data:image/") || !uri.includes(";base64,")) return

	const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, uri, -1)
	const cachePath = `${cacheDirectory}/${hash}`
	if (
		pendingWrites.has(cachePath) ||
		GLib.file_test(cachePath, GLib.FileTest.EXISTS)
	)
		return

	const decoded = attempt(() =>
		GLib.base64_decode(uri.slice(uri.indexOf(",") + 1).replace(/\s/g, "")),
	)
	if (!decoded.ok) {
		console.error("media.artwork: Failed to decode inline artwork", decoded.err)
		return
	}

	GLib.mkdir_with_parents(cacheDirectory, 0o755)
	pendingWrites.add(cachePath)
	const target = Gio.File.new_for_path(cachePath)
	target.replace_contents_async(
		decoded.value,
		null,
		false,
		Gio.FileCreateFlags.NONE,
		null,
		(_file, result) => {
			const written = attempt(() => target.replace_contents_finish(result))
			pendingWrites.delete(cachePath)
			if (!written.ok)
				console.error(
					"media.artwork: Failed to cache inline artwork",
					written.err,
				)
		},
	)
}

export const media = Media.get_default()
const playerHandlers = new WeakMap<Media.Player, number>()

function watchPlayer(player: Media.Player): void {
	if (playerHandlers.has(player)) return
	cacheInlineArtwork(player.get_art_url())
	playerHandlers.set(
		player,
		player.connect("notify::art-url", () =>
			cacheInlineArtwork(player.get_art_url()),
		),
	)
}

function unwatchPlayer(player: Media.Player): void {
	const handler = playerHandlers.get(player)
	if (handler) player.disconnect(handler)
	playerHandlers.delete(player)
}

for (const player of media.get_players()) watchPlayer(player)
media.connect("player-added", (_media, player) => watchPlayer(player))
media.connect("player-closed", (_media, player) => unwatchPlayer(player))
