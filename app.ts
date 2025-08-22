import app from "ags/gtk4/app"
import { Astal } from "ags/gtk4"


import Gdk from "gi://Gdk"
import GLib from "gi://GLib"

import Bar from "widget/Bar"
import OSD from "widget/OSD"

import init from "$lib/init"

let windows: Astal.Window[] = []

function forMonitors(widget: ((monitor: Gdk.Monitor) => any)[]) {
	const update_windows = () => {
		windows = windows.filter(w => {
			if (!w.gdkmonitor) {
				try { w.destroy() } catch (_) { }
				return false
			}
			return true
		})

		app.get_monitors().forEach(monitor => {
			if (!monitor) return

			widget.forEach(w => {
				try {
					windows.push(w(monitor))
				} catch (_) { }
			})
		})
	}

	update_windows()

	app.connect("notify::monitors", (_obj, _pspec) => {
		GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			update_windows()
			return GLib.SOURCE_REMOVE
		})
	})
}

app.start({
	main() {
		forMonitors([Bar])
		OSD()
		init()
	},
})
