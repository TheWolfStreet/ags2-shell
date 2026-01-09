import GObject, { register, getter } from "ags/gobject"
import { idle, timeout, Timer } from "ags/time"

import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"

import env from "$lib/env"
import { bashSync, fileExists } from "$lib/utils"
import { hypr } from "$lib/services"

@register()
export default class Apps extends GObject.Object {
	declare static $gtype: GObject.GType<Apps>
	static instance: Apps

	static get_default(): Apps {
		return this.instance ??= new Apps()
	}

	#favorites: Array<AstalApps.Application>
	#favortiesSnapshot: string
	#apps: AstalApps.Apps
	#monitors: Gio.FileMonitor[]
	#reloadTimeout: Timer | undefined

	constructor() {
		super()

		this.#favorites = []
		this.#favortiesSnapshot = ""
		this.#apps = new AstalApps.Apps()
		this.#monitors = []
		this.#reloadTimeout = undefined

		const reloadApps = () => {
			if (this.#reloadTimeout) {
				this.#reloadTimeout.cancel()
			}

			this.#reloadTimeout = timeout(500, () => {
				idle(() => {
					this.#apps.reload()
					this.notify("list")
					this.notify("favorites")
				})
				this.#reloadTimeout = undefined
			})
		}

		const watchAppDir = (dir: string) => {
			if (!fileExists(dir)) return

			try {
				const file = Gio.File.new_for_path(dir)
				const monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null)

				monitor.set_rate_limit(300)

				monitor.connect("changed", (_mon, file, _other, event_type) => {
					if (event_type === Gio.FileMonitorEvent.CREATED) {
						const fileName = file.get_basename()
						if (fileName && !fileName.startsWith(".")) {
							reloadApps()
						}
					} else if (event_type === Gio.FileMonitorEvent.DELETED) {
						reloadApps()
					}
				})

				this.#monitors.push(monitor)
			} catch (e) {
				console.error(`Failed to watch directory ${dir}:`, e)
			}
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
			watchAppDir(dir)
		}

		hypr.connect("config-reloaded", reloadApps)
	}

	@getter(AstalApps.Apps)
	get list() {
		return this.#apps
	}

	@getter(Array<AstalApps.Application>)
	get favorites(): Array<AstalApps.Application> {
		this.#updateFav()
		return this.#favorites
	}
	readonly #updateFav = () => {
		try {
			const raw = bashSync(
				"dconf read /org/gnome/shell/favorite-apps",
				{ encoding: "utf-8" }
			).trim()

			if (raw === this.#favortiesSnapshot) return
			this.#favortiesSnapshot = raw

			const list = JSON.parse(raw.replace(/'/g, '"'))
			if (!Array.isArray(list)) throw new Error("not an array")

			const apps: Array<AstalApps.Application> = []
			for (const item of list) {
				if (typeof item === "string") {
					const name = item.replace(/\.desktop$/, "")
					const match = this.#apps.exact_query(name)[0]
					if (match) apps.push(match)
				}
			}

			this.#favorites = apps
		} catch (e) {
			console.error("Failed to get favorite apps:", e)
			this.#favorites = []
		}
	}

	vfunc_finalize() {
		if (this.#reloadTimeout) {
			this.#reloadTimeout.cancel()
			this.#reloadTimeout = undefined
		}

		for (const monitor of this.#monitors) {
			monitor.cancel()
		}
		this.#monitors = []
		super.vfunc_finalize()
	}
}
