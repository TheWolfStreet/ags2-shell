import init from "$lib/init"
import env from "$lib/env"

import app from "ags/gtk4/app"
import { idle } from "ags/time"

import { Power } from "widget/PowerMenu"
import { Settings } from "widget/Settings"
import { Launcher } from "widget/Bar/components/Launcher"
import { Notifications } from "widget/Bar/components/Notifications"
import { Battery } from "widget/Bar/components/Battery"
import { Workspaces } from "widget/Bar/components/Overview"
import { QuickSettings } from "widget/Bar/components/QuickSettings"
import { Network } from "widget/Bar/components/QuickSettings/components/Network"
import { Date } from "widget/Bar/components/Date"
import { OSD } from "widget/OSD"
import { initMonitors } from "$lib/monitors"

import { scr } from "$lib/services"

function preloadWindows(...names: string[]) {
	idle(() => {
		for (const name of names) {
			const win = app.get_window(name)
			if (!win)
				continue

			win.set_opacity(0)
			win.set_visible(true)
			idle(() => {
				win.set_visible(false)
				win.set_opacity(1)
			})
		}
	})
}

app.start({
	instanceName: env.appName,
	main() {
		init().catch(err => console.error("Init error:", err))
		Date.Window()
		Launcher.Window()
		Power.Window()
		Power.VerificationModal()
		Notifications.Window()
		Battery.Window()
		Workspaces.Window()
		QuickSettings.Window()
		Network.Wifi.Window()
		Settings.Window()
		OSD.Window()

		preloadWindows("launcher")

		initMonitors()
	},
	requestHandler(argv: string[], res: (response: string) => void) {
		const [request, ...rest] = argv

		switch (request) {
			case "launcher-search": {
				const query = rest.join(" ")
				Launcher.setSearchQuery(query, true)
				break
			}
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
