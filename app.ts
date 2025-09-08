import app from "ags/gtk4/app"
import { Astal, Gdk } from "ags/gtk4"

import Bar from "widget/Bar"
import OSD from "widget/OSD"
import BarCorners from "widget/Bar/components/BarCorners"
import QuickSettings from "widget/Bar/components/QuickSettings"
import { Power } from "widget/PowerMenu"
import { Settings } from "widget/Settings"
import { Launcher } from "widget/Bar/components/Launcher"
import { Notifications } from "widget/Bar/components/Notifications"
import { Battery } from "widget/Bar/components/Battery"
import { Workspaces } from "widget/Bar/components/Overview"
import { Date } from "widget/Bar/components/Date"

import init from "$lib/init"
import { scr } from "$lib/services"
import { env } from "$lib/env"

let windows: Astal.Window[] = []

function forMonitors(widget: ((monitor: Gdk.Monitor) => any)[]) {
	app.get_monitors().forEach(monitor => {
		if (!monitor) return

		widget.forEach(w => {
			try {
				windows.push(w(monitor))
			} catch (_) { }
		})
	})
}
app.start({
	instanceName: env.appName,
	main() {
		Date.Window()
		Launcher.Window()
		Power.Window()
		Power.VerificationModal()
		Notifications.Window()
		Battery.Window()
		Workspaces.Window()
		OSD()
		QuickSettings()
		Settings()
		init()
		forMonitors([Bar, BarCorners])
	},
	requestHandler(argv: string[], _: (response: any) => void) {
		const [request] = argv
		if (request == "shutdown") Power.selAction("shutdown")
		if (request == "record") scr.recording ? scr.stopRecord() : scr.startRecord()
		if (request == "record-area") scr.recording ? scr.stopRecord() : scr.startRecord(true)
		if (request == "screenshot") scr.screenshot()
		if (request == "screenshot-area") scr.screenshot(true)
	},
})
