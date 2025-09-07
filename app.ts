import app from "ags/gtk4/app"
import { Astal } from "ags/gtk4"

import Gdk from "gi://Gdk"
import GLib from "gi://GLib"

import Bar from "widget/Bar"
import OSD from "widget/OSD"
import BarCorners from "widget/Bar/components/BarCorners"
import { Power } from "widget/PowerMenu"
import { Settings } from "widget/Settings"
import { Launcher } from "widget/Bar/components/Launcher"
import QuickSettings from "widget/Bar/components/QuickSettings"
import { Notifications } from "widget/Bar/components/Notifications"
import { Battery } from "widget/Bar/components/Battery"
import { Workspaces } from "widget/Bar/components/Overview"
import { Date } from "widget/Bar/components/Date"

import init from "$lib/init"
import { scr } from "$lib/services"

let windows: Astal.Window[] = []

function forMonitors(widget: ((monitor: Gdk.Monitor) => any)[]) {
	const updateWindows = () => {
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

	updateWindows()

	app.connect("notify::monitors", (_obj, _pspec) => {
		GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			updateWindows()
			return GLib.SOURCE_REMOVE
		})
	})
}

app.start({
	main() {
		forMonitors([Bar, BarCorners])
		Date.Window()
		Launcher.Window()
		Power.Window()
		Power.VerificationModal()
		Notifications.Window()
		Battery.Window()
		OSD()
		Workspaces.Window()
		QuickSettings()
		Settings()
		init()
	},

	requestHandler(request: string, _: (response: any) => void) {
		if (request == "shutdown") Power.selAction("shutdown")
		if (request == "record") scr.recording ? scr.stopRecord() : scr.startRecord()
		if (request == "record-area") scr.recording ? scr.stopRecord() : scr.startRecord(true)
		if (request == "screenshot") scr.screenshot()
		if (request == "screenshot-area") scr.screenshot(true)
	},
})
