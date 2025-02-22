import AstalApps from "gi://AstalApps"
import { Gio, GLib, register, GObject, property } from "astal"

@register({ GTypeName: "AppsWatched" })
export default class Apps extends GObject.Object {
	static instance: Apps
	static get_default() {
		if (!this.instance)
			this.instance = new Apps()
		return this.instance
	}

	#apps = new AstalApps.Apps
	#monitors: Gio.FileMonitor[] = []

	@property(Object)
	get apps() {
		return this.#apps
	}

	constructor() {
		super()
		const home = GLib.get_home_dir()
		const appDirs = [
			`${home}/.local/share/applications/`,
			`${home}/.local/share/flatpak/.changed`,
		]

		for (const dir of appDirs) {
			if (GLib.file_test(dir, GLib.FileTest.EXISTS)) {
				const file = Gio.File.new_for_path(dir);
				const monitor = GLib.file_test(dir, GLib.FileTest.IS_DIR)
					? file.monitor_directory(Gio.FileMonitorFlags.NONE, null)
					: file.monitor_file(Gio.FileMonitorFlags.NONE, null);
				monitor.set_rate_limit(100)
				monitor.connect("changed", (_, __, ___, ____) => {
					this.#apps.reload();
					this.notify("apps");
				});
				this.#monitors.push(monitor)
			}
		}
	}
}
