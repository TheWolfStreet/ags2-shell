// Starts services and windows and handles launcher, power, recording, and screenshot requests.

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
import { initMonitors } from "$lib/monitor-manager"
import { startWallpaperProcess } from "widget/Wallpaper"

import { capturer } from "$service/capturer"

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

function toggleRecording(selectArea: boolean) {
	if (capturer.recording)
		capturer.stopRecord()
	else
		capturer.startRecord(selectArea)
}

app.start({
	instanceName: env.appName,
	main() {
		startWallpaperProcess()
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
				toggleRecording(false)
				break
			case "record-area":
				toggleRecording(true)
				break
			case "screenshot":
				capturer.screenshot()
				break
			case "screenshot-area":
				capturer.screenshot(true)
				break
			default:
				res(`Unknown request: ${request}`)
				return
		}

		res("Request handled successfully")
	},
})
