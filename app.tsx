// Starts services and windows and handles launcher, power, recording, and screenshot requests.

import startShell from "startup"
import env from "$lib/env"

import app from "ags/gtk4/app"
import { idle } from "ags/time"

import { PowerMenu } from "widget/PowerMenu"
import { Settings } from "widget/Settings"
import { Launcher } from "widget/Bar/components/Launcher"
import { Notifications } from "widget/Bar/components/Notifications"
import { Battery } from "widget/Bar/components/Battery"
import { Overview } from "widget/Bar/components/Overview"
import { QuickSettings } from "widget/Bar/components/QuickSettings"
import { Network } from "widget/Bar/components/QuickSettings/components/Network"
import { DateMenu } from "widget/Bar/components/DateMenu"
import { OSD } from "widget/OSD"
import { startMonitorWindows } from "widget/Windowing/MonitorManager"
import { startWallpaperSupervisor } from "widget/Wallpaper"

import { screenCapture } from "widget/Bar/components/Buttons/ScreenCapture"

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
	if (screenCapture.recording)
		screenCapture.stopRecording()
	else
		screenCapture.startRecording(selectArea)
}

app.start({
	instanceName: env.appName,
	main() {
		startWallpaperSupervisor()
		startShell().catch(err => console.error("Startup error:", err))
		DateMenu.Window()
		Launcher.Window()
		PowerMenu.Window()
		PowerMenu.VerificationModal()
		Notifications.Window()
		Battery.Window()
		Overview.Window()
		QuickSettings.Window()
		Network.Wifi.Window()
		Settings.Window()
		OSD.Window()

		preloadWindows("launcher")

		startMonitorWindows()
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
				PowerMenu.requestActionConfirmation("shutdown")
				break
			case "record":
				toggleRecording(false)
				break
			case "record-area":
				toggleRecording(true)
				break
			case "screenshot":
				screenCapture.screenshot()
				break
			case "screenshot-area":
				screenCapture.screenshot(true)
				break
			default:
				res(`Unknown request: ${request}`)
				return
		}

		res("Request handled successfully")
	},
})
