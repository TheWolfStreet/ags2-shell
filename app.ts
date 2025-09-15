import app from "ags/gtk4/app"
import { Astal, Gdk } from "ags/gtk4"

import { Bar } from "widget/Bar"
import { BarCorners } from "widget/Bar/components/BarCorners"
import { Power } from "widget/PowerMenu"
import { Settings } from "widget/Settings"
import { Launcher } from "widget/Bar/components/Launcher"
import { Notifications } from "widget/Bar/components/Notifications"
import { Battery } from "widget/Bar/components/Battery"
import { Workspaces } from "widget/Bar/components/Overview"
import { QuickSettings } from "widget/Bar/components/QuickSettings"
import { Date } from "widget/Bar/components/Date"
import { OSD } from "widget/OSD"

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
		init()
		Date.Window()
		Launcher.Window()
		Power.Window()
		Power.VerificationModal()
		Notifications.Window()
		Battery.Window()
		Workspaces.Window()
		QuickSettings.Window()
		Settings.Window()
		OSD()
		forMonitors([Bar, BarCorners])
	},
	requestHandler(argv: string[], res: (response: string) => void) {
		const [request] = argv

		switch (request) {
			case "shutdown":
				Power.selAction("shutdown")
				break
			case "record":
				scr.recording ? scr.stopRecord() : scr.startRecord()
				break
			case "record-area":
				scr.recording ? scr.stopRecord() : scr.startRecord(true)
				break
			case "screenshot":
				scr.screenshot()
				break
			case "screenshot-area":
				scr.screenshot(true)
				break
			default:
				res(`Unknown request: ${request}`)
				return
		}

		res("Request handled successfully")
	},
})
