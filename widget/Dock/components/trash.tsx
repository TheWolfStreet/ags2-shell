import { createState } from "ags"

import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import type AstalHyprland from "gi://AstalHyprland"

import { hyprland } from "$lib/hyprland"
import {
	attempt,
	attempt_async,
	err,
	log_error,
	ok,
	type result,
} from "$lib/result"
import { debounce } from "$lib/time"
import {
	focus_client,
	get_client_workspace_id,
	move_client_to_workspace_silent,
} from "$lib/windowing"
import { base_name } from "$lib/text"

const trash_uri = "trash:///"
const refresh_debounce_ms = 120

let watcher_users = 0
let watcher: Gio.FileMonitor | null = null
const [has_items, set_has_items] = createState(false)
export { has_items }

async function read_trash_has_items(): Promise<result<boolean>> {
	const dir = Gio.File.new_for_uri(trash_uri)
	const opened = await attempt_async(() =>
		dir.enumerate_children_async(
			"standard::name",
			Gio.FileQueryInfoFlags.NONE,
			GLib.PRIORITY_DEFAULT,
			null,
		),
	)
	if (!opened.ok) return opened

	const enumerator = opened.value
	const items = await attempt_async(() =>
		enumerator.next_files_async(1, GLib.PRIORITY_DEFAULT, null),
	)
	const closed = await attempt_async(() =>
		enumerator.close_async(GLib.PRIORITY_DEFAULT, null),
	)
	if (!closed.ok) return closed
	if (!closed.value) return err(new Error("Failed to close Trash enumeration"))
	if (!items.ok) return items
	return ok(items.value.length > 0)
}

async function refresh_state() {
	const result = await read_trash_has_items()
	if (!log_error(result, "dock.trash.refresh: Failed to refresh trash state"))
		return
	if (watcher_users > 0) set_has_items(result.value)
}

const refresh = debounce(refresh_debounce_ms, refresh_state)

export function acquire_trash_watcher() {
	watcher_users += 1
	if (watcher_users > 1) return release_trash_watcher

	void refresh_state()
	const watched = attempt(() => {
		const dir = Gio.File.new_for_uri(trash_uri)
		watcher = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
		watcher.connect("changed", () => refresh.call())
	})
	log_error(watched, `dock.trash.watch: Failed to watch ${trash_uri}`)
	return release_trash_watcher
}

function release_trash_watcher() {
	watcher_users = Math.max(0, watcher_users - 1)
	if (watcher_users > 0) return

	watcher?.cancel()
	watcher = null
	refresh.cancel()
}

export function open_trash() {
	void open_or_focus_trash().then((opened) =>
		log_error(opened, "dock.trash.open: Failed to open or focus trash"),
	)
}

function file_manager_identities() {
	const app = Gio.AppInfo.get_default_for_type("inode/directory", false)
	const app_id = app?.get_id()
	const id = app_id?.replace(/\.desktop$/i, "").toLowerCase()
	const wm_class = app_id
		? GioUnix.DesktopAppInfo.new(app_id)?.get_startup_wm_class()?.toLowerCase()
		: null
	const path = app?.get_executable()
	const executable = path ? base_name(path).toLowerCase() : undefined
	return [id, wm_class, executable].filter((value) => !!value)
}

function find_trash_window(): result<AstalHyprland.Client | undefined> {
	return attempt(() => {
		const identities = file_manager_identities()
		return hyprland.clients.find(
			(client) =>
				client.get_title() === "Trash" &&
				identities.includes(client.get_class()?.toLowerCase()),
		)
	})
}

async function focus_on_workspace(
	client: AstalHyprland.Client,
	workspace_id: number,
): Promise<result<void>> {
	if (get_client_workspace_id(client) !== workspace_id) {
		const moved = await move_client_to_workspace_silent(workspace_id, client)
		if (!moved.ok) return moved
	}
	return focus_client(client)
}

function launch_trash(): result<void> {
	const launched = attempt(() =>
		Gio.app_info_launch_default_for_uri(trash_uri, null),
	)
	if (!launched.ok) return launched
	if (!launched.value) return err(new Error("No application could open Trash"))
	return ok(undefined)
}

async function open_or_focus_trash(): Promise<result<void>> {
	const found = find_trash_window()
	const workspace_id = hyprland.focusedWorkspace?.id
	if (found.ok && found.value && workspace_id != null)
		return focus_on_workspace(found.value, workspace_id)
	return launch_trash()
}
