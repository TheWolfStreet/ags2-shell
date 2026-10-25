import GObject, { getter, register } from "ags/gobject"
import { execAsync, Process, subprocess } from "ags/process"
import app from "$lib/app"
import { debounce, idle, timeout, type timer } from "$lib/time"

import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt, attempt_async, log_error } from "$lib/result"
import { describe_exit } from "$lib/text"

type catalog_index = {
	entries: Map<string, AstalApps.Application>
	stems: Map<string, AstalApps.Application>
	names: Map<string, AstalApps.Application>
}

const favorites_key = "/org/gnome/shell/favorite-apps"

function desktop_stem(name: string) {
	return name.replace(/\.desktop$/i, "")
}

function remember(
	index: Map<string, AstalApps.Application>,
	key: string,
	app: AstalApps.Application,
) {
	if (!index.has(key)) index.set(key, app)
}

function index_catalog(apps: AstalApps.Application[]): catalog_index {
	const index: catalog_index = {
		entries: new Map(),
		stems: new Map(),
		names: new Map(),
	}
	for (const app of apps) {
		const entry = app.get_entry()?.toLowerCase()
		if (entry) {
			remember(index.entries, entry, app)
			remember(index.stems, desktop_stem(entry), app)
		}
		remember(index.names, app.get_name().toLowerCase(), app)
	}
	return index
}

function find_app(index: catalog_index, name: string) {
	const key = name.toLowerCase()
	return (
		index.entries.get(key) ??
		index.stems.get(key) ??
		index.names.get(key) ??
		index.names.get(desktop_stem(key))
	)
}

function parse_favorite_names(raw: string): string[] {
	return GLib.Variant.parse(
		new GLib.VariantType("as"),
		raw || "[]",
		null,
		null,
	).get_strv()
}

function resolve_favorites(
	names: string[],
	apps: AstalApps.Application[],
): AstalApps.Application[] {
	const index = index_catalog(apps)
	const favorites: AstalApps.Application[] = []
	const seen = new Set<string>()
	for (const name of names) {
		const app = find_app(index, name)
		const entry = app?.get_entry()?.toLowerCase()
		if (!app || !entry || seen.has(entry)) continue
		favorites.push(app)
		seen.add(entry)
	}
	return favorites
}

@register()
class ApplicationCatalog extends GObject.Object {
	declare static $gtype: GObject.GType<ApplicationCatalog>

	#favorites: AstalApps.Application[] = []
	#favorites_snapshot: string | null = null
	#favorites_read = 0
	#apps: AstalApps.Apps
	#app_monitor: Gio.AppInfoMonitor
	#app_handler: number
	#favorites_watcher: Process | null = null
	#watch_retry: timer | null = null
	#watch_failures = 0
	#finished = false
	#refresh_idle: timer | null = null
	#favorites_refresh = debounce(75, () => this.#refresh_favorites())

	constructor() {
		super()
		app.connect("shutdown", () => this.#dispose())

		this.#apps = new AstalApps.Apps()
		this.#app_monitor = Gio.AppInfoMonitor.get()
		this.#app_handler = this.#app_monitor.connect("changed", () =>
			this.#schedule_catalog_refresh(),
		)
		this.#watch_favorites()
		void this.#refresh_favorites()
	}

	@getter(Array<AstalApps.Application>)
	get list() {
		return this.#apps.list
	}

	@getter(Array<AstalApps.Application>)
	get favorites(): AstalApps.Application[] {
		return this.#favorites
	}

	#schedule_catalog_refresh() {
		if (this.#refresh_idle) return
		this.#refresh_idle = idle(() => {
			this.#refresh_idle = null
			if (this.#favorites_snapshot !== null)
				this.#set_favorites(this.#favorites_snapshot, true)
			this.notify("list")
		})
	}

	#watch_favorites() {
		const watched = attempt(() =>
			subprocess(
				["dconf", "watch", favorites_key],
				() => {
					this.#watch_failures = 0
					this.#favorites_refresh.call()
				},
				(error) => console.error("applications.favorites_watch:", error),
			),
		)
		if (!log_error(watched, "applications.favorites_watch:")) {
			this.#retry_watch()
			return
		}
		this.#favorites_watcher = watched.value
		watched.value.connect("exit", (_process, code, signaled) =>
			this.#on_watch_exit(code, signaled),
		)
	}

	#on_watch_exit(code: number, signaled: boolean) {
		if (this.#finished) return
		this.#favorites_watcher = null
		console.error(
			`applications.favorites_watch: Dconf watch exited with ${describe_exit(code, signaled)}`,
		)
		this.#retry_watch()
	}

	#retry_watch() {
		if (this.#watch_retry || this.#watch_failures >= 3 || this.#finished) return
		const delay = 5000 * 3 ** this.#watch_failures++
		this.#watch_retry = timeout(delay, () => {
			this.#watch_retry = null
			this.#watch_favorites()
			void this.#refresh_favorites()
		})
	}

	async #refresh_favorites() {
		const read = ++this.#favorites_read
		const raw = await attempt_async(() =>
			execAsync(["dconf", "read", favorites_key]),
		)
		if (
			!log_error(
				raw,
				"applications.refresh_favorites: Failed to read favorites",
			)
		)
			return
		if (read === this.#favorites_read) this.#set_favorites(raw.value.trim())
	}

	#set_favorites(raw: string, remap = false) {
		if (!remap && raw === this.#favorites_snapshot) return
		const resolved = attempt(() =>
			resolve_favorites(parse_favorite_names(raw), this.#apps.list),
		)
		if (
			!log_error(
				resolved,
				"applications.set_favorites: Failed to read favorite apps",
			)
		)
			return
		this.#favorites_snapshot = raw
		this.#favorites = resolved.value
		this.notify("favorites")
	}

	#dispose() {
		if (this.#finished) return
		this.#finished = true
		this.#favorites_read++
		this.#favorites_refresh.cancel()
		this.#watch_retry?.cancel()
		this.#refresh_idle?.cancel()
		this.#favorites_watcher?.kill()
		this.#app_monitor.disconnect(this.#app_handler)
	}

	vfunc_finalize() {
		this.#dispose()
		super.vfunc_finalize()
	}
}

export const applications = new ApplicationCatalog()
