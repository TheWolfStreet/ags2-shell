import GObject, { register, getter } from "ags/gobject"

import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"

import { env } from "$lib/env"
import { bashSync, fileExists } from "$lib/utils"
import { hypr } from "$lib/services"

@register({ GTypeName: "Apps" })
export default class Apps extends GObject.Object {
	static instance: Apps

	static get_default(): Apps {
		return this.instance ??= new Apps()
	}

	#apps = new AstalApps.Apps
	#monitors: Gio.FileMonitor[] = []

	constructor() {
		super()

		const stack = [
			`${env.paths.home}/.local/share/applications/`,
			`${env.paths.home}/.local/share/flatpak/applications/`,
			"/var/lib/flatpak/exports/share/applications",
		]

		const watchDir = (dir: string) => {
			if (!fileExists(dir)) return

			const file = Gio.File.new_for_path(dir)
			const monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null)

			monitor.set_rate_limit(200)

			monitor.connect("changed", () => {
				this.#apps.reload()
				this.notify("list")
			})

			this.#monitors.push(monitor)

			const iter = file.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null)
			let info
			while ((info = iter?.next_file(null))) {
				if (info.get_file_type() === Gio.FileType.DIRECTORY) {
					watchDir(`${dir}/${info.get_name()}`)
				}
			}
			iter?.close(null)
		}

		// When nixos configuration is switched, hyprland is reloaded
		// This is a decent way to reload apps if packages were changed
		hypr.connect("config-reloaded", () => {
			this.#apps.reload()
		})

		for (const root of stack) {
			watchDir(root)
		}
	}

	@getter(AstalApps.Apps)
	get list() {
		return this.#apps
	}

	@getter(Array<AstalApps.Application>)
	get favorites(): Array<AstalApps.Application> {
		try {
			const raw = bashSync("dconf read /org/gnome/shell/favorite-apps", { encoding: "utf-8" })
			const list = JSON.parse(raw.replace(/'/g, '"'))

			if (!Array.isArray(list)) throw new Error("not an array")

			const apps = []
			for (const item of list) {
				if (typeof item !== "string") continue
				const name = item.replace(/\.desktop$/, "")
				const match = this.#apps.fuzzy_query(name)[0]
				if (match) apps.push(match)
			}

			return apps
		} catch (e) {
			console.error("Failed to get favorite apps:", e)
			return []
		}
	}
}
