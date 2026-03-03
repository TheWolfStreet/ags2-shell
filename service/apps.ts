import GObject, { getter, register } from "ags/gobject"
import { execAsync } from "ags/process"
import { idle } from "ags/time"

import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"

import env from "$lib/env"
import { fileExists } from "$lib/files"
import { attempt } from "$lib/result"
import { hypr } from "$lib/services"
import { debounce } from "$lib/timing"

@register()
export default class Apps extends GObject.Object {
	declare static $gtype: GObject.GType<Apps>
	static instance: Apps

	static get_default(): Apps {
		return this.instance ??= new Apps()
	}

	#favorites: Array<AstalApps.Application>
	#favoritesSnapshot: string
	#favoritesRefreshing = false
	#lastFavoritesRead = 0
	#apps: AstalApps.Apps
	#monitors: Gio.FileMonitor[]
	#reload = debounce(500, () => idle(() => {
		this.#apps.reload()
		this.notify("list")
		this.notify("favorites")
	}))

	constructor() {
		super()

		this.#favorites = []
		this.#favoritesSnapshot = ""
		this.#apps = new AstalApps.Apps()
		this.#monitors = []

		const scheduleReload = () => this.#reload.call()

		const watchDirectory = (dir: string) => {
			if (!fileExists(dir)) return

			const result = attempt(() => {
				const file = Gio.File.new_for_path(dir)
				const monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null)

				monitor.set_rate_limit(300)

				monitor.connect("changed", (_mon, file, _other, event_type) => {
					if (event_type === Gio.FileMonitorEvent.CREATED) {
						const fileName = file.get_basename()
						if (fileName && !fileName.startsWith(".")) {
							scheduleReload()
						}
					} else if (event_type === Gio.FileMonitorEvent.DELETED) {
						scheduleReload()
					}
				})

				this.#monitors.push(monitor)
			})
			if (!result.ok)
				console.error(`apps.watchDirectory: Failed to watch ${dir}`, result.err)
		}

		const appDirs = [
			`${env.paths.home}/.local/share/applications/`,
			`${env.paths.home}/.local/share/flatpak/exports/share/applications/`,
			`${env.paths.home}/.local/share/flatpak/app/`,
			"/usr/share/applications/",
			"/usr/local/share/applications/",
			"/var/lib/flatpak/exports/share/applications/",
			"/var/lib/flatpak/app/",
		]

		for (const dir of appDirs) {
			watchDirectory(dir)
		}

		hypr.connect("config-reloaded", scheduleReload)

		this.#lastFavoritesRead = Date.now()
		this.#refreshFavorites()
	}

	@getter(Array<AstalApps.Application>)
	get list() {
		return this.#apps.list
	}

	@getter(Array<AstalApps.Application>)
	get favorites(): Array<AstalApps.Application> {
		const now = Date.now()
		if (now - this.#lastFavoritesRead > 2000) {
			this.#lastFavoritesRead = now
			this.#refreshFavorites()
		}
		return this.#favorites
	}

	readonly #refreshFavorites = () => {
		if (this.#favoritesRefreshing) return
		this.#favoritesRefreshing = true
		execAsync(["dconf", "read", "/org/gnome/shell/favorite-apps"])
			.then(raw => this.#setFavorites(raw.trim()))
			.finally(() => { this.#favoritesRefreshing = false })
	}

	readonly #setFavorites = (raw: string) => {
		if (raw === this.#favoritesSnapshot) return
		this.#favoritesSnapshot = raw

		const result = attempt(() => {
			const apps: Array<AstalApps.Application> = []
			for (const [, entry] of raw.matchAll(/'([^']*)'/g)) {
				const name = entry.replace(/\.desktop$/, "")
				const key = name.toLowerCase()
				const results = this.#apps.exact_query(name)
				const match = results.find(app =>
					app.get_name().toLowerCase() === key
					|| app.get_entry()?.replace(/\.desktop$/, "").toLowerCase() === key,
				) ?? results[0]
				if (match) apps.push(match)
			}
			return apps
		})

		if (!result.ok) {
			console.error("apps.setFavorites: Failed to read favorite apps", result.err)
			this.#favorites = []
		} else {
			this.#favorites = result.value
		}

		this.notify("favorites")
	}

	vfunc_finalize() {
		this.#reload.cancel()

		for (const monitor of this.#monitors) {
			monitor.cancel()
		}
		this.#monitors = []
		super.vfunc_finalize()
	}
}
