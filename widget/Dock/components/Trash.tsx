// Watches the trash folder and opens it when the dock icon is clicked.

import { createState } from "ags"

import AstalHyprland from "gi://AstalHyprland"
import Gio from "gi://Gio"

import env from "$lib/env"
import { ensureDirectory } from "$lib/files"
import { attempt } from "$lib/result"
import { debounce } from "$lib/time"
import { getClientWorkspaceId, moveClientToWorkspaceSilent } from "$lib/windowing"

const TRASH_DIR = env.paths.trash
const REFRESH_DEBOUNCE_MS = 120

let watcherUsers = 0
let watcher: Gio.FileMonitor | null = null
const [_hasItems, setHasItems] = createState(false)
export const hasItems = _hasItems

function refreshState() {
	const result = attempt(() => {
		const dir = Gio.File.new_for_path(TRASH_DIR)
		if (!dir.query_exists(null))
			return false

		const enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
		const hasItem = enumerator.next_file(null) !== null
		enumerator.close(null)
		return hasItem
	})

	if (!result.ok)
		console.error("dock.trash.refresh: Failed to refresh trash state", result.err)

	setHasItems(result.ok && result.value)
}

const refresh = debounce(REFRESH_DEBOUNCE_MS, refreshState)

export function acquireTrashWatcher() {
	watcherUsers += 1
	if (watcherUsers === 1) {
		refreshState()

		const result = attempt(() => {
			ensureDirectory(TRASH_DIR)
			const dir = Gio.File.new_for_path(TRASH_DIR)
			watcher = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
			watcher.connect("changed", () => refresh.call())
		})

		if (!result.ok)
			console.error(`dock.trash.watch: Failed to watch ${TRASH_DIR}`, result.err)
	}

	return releaseTrashWatcher
}

function releaseTrashWatcher() {
	watcherUsers = Math.max(0, watcherUsers - 1)
	if (watcherUsers > 0)
		return

	watcher?.cancel()
	watcher = null

	refresh.cancel()
}

export function openOrFocus(clients: AstalHyprland.Client[], activeWorkspaceId: number | null | undefined) {
	const result = attempt(() => {
		const existing = clients.find(c =>
			(c.get_title?.() ?? "").toLowerCase().includes("trash") ||
			(c.get_class?.() ?? "").toLowerCase().includes("trash")
		)

		if (existing && activeWorkspaceId != null) {
			const currentId = getClientWorkspaceId(existing)
			if (currentId !== activeWorkspaceId)
				moveClientToWorkspaceSilent(activeWorkspaceId, existing)
			existing.focus()
			return
		}

		Gio.app_info_launch_default_for_uri("trash:///", null)
	})

	if (!result.ok)
		console.error("dock.trash.open_or_focus: Failed to open or focus trash", result.err)
}
