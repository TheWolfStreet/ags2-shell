import GObject, { register, getter } from "ags/gobject"

import AstalApps from "gi://AstalApps"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

import { env } from "$lib/env"
import { bashSync } from "$lib/utils"

@register({ GTypeName: "AppsWatched" })
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
		]

		for (const root of stack) {
			if (!GLib.file_test(root, GLib.FileTest.EXISTS)) continue

			const dirs: string[] = []
			const iter = Gio.File.new_for_path(root).enumerate_children(
				"standard::name,standard::type",
				Gio.FileQueryInfoFlags.NONE,
				null,
			)

			let info
			while ((info = iter?.next_file(null))) {
				const name = info.get_name()
				if (info.get_file_type() === Gio.FileType.DIRECTORY)
					dirs.push(`${root}/${name}`)
			}
			iter?.close(null)

			for (const dir of [root, ...dirs]) {
				if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) continue

				const file = Gio.File.new_for_path(dir)
				const monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null)
				monitor.set_rate_limit(100)
				monitor.connect("changed", () => {
					this.#apps.reload()
					this.notify("apps")
				})
				this.#monitors.push(monitor)
			}
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

			let apps = list
				.filter(item => typeof item === "string")
				.map(item => item.replace(/\.desktop$/, ""))
				.map(name => this.#apps.fuzzy_query(name)[0])
				.filter(app => app !== undefined)

			return apps
		} catch (e) {
			console.error("Failed to get favorite apps:", e)
			return []
		}
	}
}
