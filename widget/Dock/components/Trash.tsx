import { createState } from "ags"

import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"

import { hyprland } from "$lib/hyprland"
import { attempt, err, log_error, ok, type Result } from "$lib/result"
import { debounce } from "$lib/time"
import { get_client_workspace_id, move_client_to_workspace_silent } from "$lib/windowing"

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
	void open_or_focus_trash().then((result) => {
		log_error(result, "dock.trash.open: Failed to open or focus trash")
	})
}

async function open_or_focus_trash(): Promise<Result<void>> {
	const found = attempt(() => {
		const app = Gio.AppInfo.get_default_for_type("inode/directory", false)
		const app_id = app?.get_id()
		const id = app_id?.replace(/\.desktop$/i, "").toLowerCase()
		const wm_class = app_id
			? GioUnix.DesktopAppInfo.new(app_id)?.get_startup_wm_class()?.toLowerCase()
			: null
		const executable = app?.get_executable()?.split("/").pop()?.toLowerCase()
		const identities = [id, wm_class, executable].filter((value) => !!value)
		return identities.length ? hyprland.clients.find((client) =>
			client.get_title() === "Trash" &&
			identities.includes(client.get_class()?.toLowerCase())) : undefined
	})
	const workspace_id = hyprland.focusedWorkspace?.id
	if (found.ok && found.value && workspace_id != null) {
		const client = found.value
		if (get_client_workspace_id(client) !== workspace_id) {
			const moved = await move_client_to_workspace_silent(workspace_id, client)
			if (!moved.ok) return moved
		}
		return attempt(() => { client.focus() })
	}

	const launched = attempt(() => Gio.app_info_launch_default_for_uri(trash_uri, null))
	if (!launched.ok) return launched
	return launched.value ? ok(undefined) : err(new Error("No application could open Trash"))
}
