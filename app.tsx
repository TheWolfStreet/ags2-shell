import init from "$lib/init"
import env from "$lib/env"

import app from "ags/gtk4/app"
import { createBinding, For, This } from "ags"

import { Bar } from "widget/Bar"
import { BarCorners } from "widget/Bar/components/BarCorners"
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

import { scr } from "$lib/services"

app.start({
	instanceName: env.appName,
	main() {
		const monitors = createBinding(app, "monitors");
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
		OSD()

		return (
			<For each={monitors}>
				{(monitor) => (
					<This this={app}>
						<Bar gdkmonitor={monitor} />
						<BarCorners gdkmonitor={monitor} />
					</This>
				)}
			</For>
		)
	},
	requestHandler(argv: string[], res: (response: string) => void) {
		const [request] = argv

		switch (request) {
			case "shutdown":
				Power.selAction("shutdown")
				break;
			case "record":
				scr.recording ? scr.stopRecord() : scr.startRecord()
				break;
			case "record-area":
				scr.recording ? scr.stopRecord() : scr.startRecord(true)
				break;
			case "screenshot":
				scr.screenshot()
				break;
			case "screenshot-area":
				scr.screenshot(true)
				break;
			default:
				res(`Unknown request: ${request}`)
				return;
		}

		res("Request handled successfully")
	},
})
