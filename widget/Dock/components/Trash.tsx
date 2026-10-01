import { createState } from "ags"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt, log_error } from "$lib/result"
import { debounce } from "$lib/time"

const trash_uri = "trash:///"
const refresh_debounce_ms = 120

let watcher_users = 0
let watcher: Gio.FileMonitor | null = null
const [has_items, set_has_items] = createState(false)
export { has_items }

async function refresh_state() {
	try {
		const dir = Gio.File.new_for_uri(trash_uri)
		const enumerator = await dir.enumerate_children_async("standard::name",
			Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null)
		try {
			const items = await enumerator.next_files_async(1, GLib.PRIORITY_DEFAULT, null)
			if (watcher_users > 0) set_has_items(items.length > 0)
		} finally {
			if (!await enumerator.close_async(GLib.PRIORITY_DEFAULT, null))
				throw new Error("Failed to close Trash enumeration")
		}
	} catch (error) {
		console.error("dock.trash.refresh: Failed to refresh trash state", error)
	}
}

const refresh = debounce(refresh_debounce_ms, refresh_state)

export function acquire_trash_watcher() {
	watcher_users += 1
	if (watcher_users === 1) {
		void refresh_state()

		const result = attempt(() => {
			const dir = Gio.File.new_for_uri(trash_uri)
			watcher = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
			watcher.connect("changed", () => refresh.call())
		})

		log_error(result, `dock.trash.watch: Failed to watch ${trash_uri}`)
	}

	return release_trash_watcher
}

function release_trash_watcher() {
	watcher_users = Math.max(0, watcher_users - 1)
	if (watcher_users > 0)
		return

	watcher?.cancel()
	watcher = null

	refresh.cancel()
}

export function open_trash() {
	const result = attempt(() => {
		if (!Gio.app_info_launch_default_for_uri(trash_uri, null))
			throw new Error("No application could open Trash")
	})

	log_error(result, "dock.trash.open: Failed to open trash")
}
