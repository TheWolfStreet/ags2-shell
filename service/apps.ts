import GObject, { getter, register } from "ags/gobject"
import { execAsync, Process, subprocess } from "ags/process"
import { idle, timeout, type Timer } from "$lib/time"

import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt } from "$lib/result"
import { debounce } from "$lib/time"

@register()
class ApplicationCatalog extends GObject.Object {
	declare static $gtype: GObject.GType<ApplicationCatalog>

	#favorites: Array<AstalApps.Application>
	#favorites_snapshot: string | null = null
	#favorites_read = 0
	#apps: AstalApps.Apps
	#app_monitor: Gio.AppInfoMonitor
	#app_handler: number
	#favorites_watcher: Process | null = null
	#watch_retry: Timer | null = null
	#watch_failures = 0
	#finished = false
	#refresh_idle: Timer | null = null
	#favorites_refresh = debounce(75, () => this.#refresh_favorites())

	constructor() {
		super()

		this.#favorites = []
		this.#apps = new AstalApps.Apps()
		this.#app_monitor = Gio.AppInfoMonitor.get()
		this.#app_handler = this.#app_monitor.connect("changed", () => {
			if (this.#refresh_idle) return
			this.#refresh_idle = idle(() => {
				this.#refresh_idle = null
				if (this.#favorites_snapshot !== null) this.#set_favorites(this.#favorites_snapshot, true)
				this.notify("list")
			})
		})
		this.#watch_favorites()
		this.#refresh_favorites()
	}

	#watch_favorites() {
		const watched = attempt(() => subprocess(
			["dconf", "watch", "/org/gnome/shell/favorite-apps"],
			() => {
				this.#watch_failures = 0
				this.#favorites_refresh.call()
			},
			(error) => console.error("applications.favoritesWatch:", error),
		))
		if (!watched.ok) {
			console.error("applications.favoritesWatch:", watched.err)
			this.#retry_watch()
			return
		}
		this.#favorites_watcher = watched.value
		watched.value.connect("exit", (source_process, code, signaled) => {
			if (this.#finished) return
			this.#favorites_watcher = null
			console.error(`applications.favoritesWatch: dconf watch exited with ${signaled ? "signal" : "status"} ${code}`)
			this.#retry_watch()
		})
	}

	#retry_watch() {
		if (this.#watch_retry || this.#watch_failures >= 3 || this.#finished) return
		const delay = 5000 * 3 ** this.#watch_failures++
		this.#watch_retry = timeout(delay, () => {
			this.#watch_retry = null
			this.#watch_favorites()
			this.#refresh_favorites()
		})
	}

	@getter(Array<AstalApps.Application>)
	get list() {
		return this.#apps.list
	}

	@getter(Array<AstalApps.Application>)
	get favorites(): Array<AstalApps.Application> {
		return this.#favorites
	}

	readonly #refresh_favorites = () => {
		const read = ++this.#favorites_read
		execAsync(["dconf", "read", "/org/gnome/shell/favorite-apps"])
			.then((raw) => {
				if (read === this.#favorites_read) this.#set_favorites(raw.trim())
			})
			.catch((error) =>
				console.error(
					"applications.refreshFavorites: Failed to read favorites",
					error,
				),
			)
	}

	readonly #set_favorites = (raw: string, remap = false) => {
		if (!remap && raw === this.#favorites_snapshot) return

		const result = attempt(() => {
			const names = GLib.Variant.parse(new GLib.VariantType("as"), raw || "[]", null, null).get_strv()
			const entries = new Map<string, AstalApps.Application>()
			const short_entries = new Map<string, AstalApps.Application>()
			const app_names = new Map<string, AstalApps.Application>()
			for (const app of this.#apps.list) {
				const entry = app.get_entry()
				if (entry) {
					const key = entry.toLowerCase()
					if (!entries.has(key)) entries.set(key, app)
					const short_key = key.replace(/\.desktop$/i, "")
					if (!short_entries.has(short_key)) short_entries.set(short_key, app)
				}
				const name = app.get_name().toLowerCase()
				if (!app_names.has(name)) app_names.set(name, app)
			}
			const favorites: AstalApps.Application[] = []
			const seen = new Set<string>()
			for (const name of names) {
				const key = name.toLowerCase()
				const app = entries.get(key) ?? short_entries.get(key) ?? app_names.get(key) ?? app_names.get(key.replace(/\.desktop$/i, ""))
				const entry = app?.get_entry()?.toLowerCase()
				if (app && entry && !seen.has(entry)) {
					favorites.push(app)
					seen.add(entry)
				}
			}
			return favorites
		})

		if (!result.ok) {
			console.error("applications.setFavorites: Failed to read favorite apps", result.err)
			return
		}
		this.#favorites_snapshot = raw
		this.#favorites = result.value

		this.notify("favorites")
	}

	vfunc_finalize() {
		this.#finished = true
		this.#favorites_read++
		this.#favorites_refresh.cancel()
		this.#watch_retry?.cancel()
		this.#refresh_idle?.cancel()
		this.#favorites_watcher?.kill()
		this.#app_monitor.disconnect(this.#app_handler)
		super.vfunc_finalize()
	}
}

export const applications = new ApplicationCatalog()
