import { App, Gdk } from "astal/gtk3"

import { powermenu, scr } from "./lib/services"

import Bar from "./widget/Bar"
import Launcher from "./widget/Bar/components/Launcher"
import Settings from "./widget/Settings"
import NotificationPopups from "./widget/Bar/components/NotificationPopups"
import Overview from "./widget/Bar/components/Overview"
import ScreenCorners from "./widget/Bar/components/ScreenCorners"
import PowerMenu, { VerificationPopup } from "./widget/PowerMenu/"
import "./style/style"
import OSD from "./widget/OSD"
import init from "./lib/init"

function forMonitors(widgets: ((monitor: Gdk.Monitor) => void)[]) {
	App.get_monitors().forEach(monitor => {
		widgets.forEach(widget => widget(monitor))
	})

	App.connect("monitor-added", (_s, monitor) => {
		widgets.forEach(widget => widget(monitor))
	})

	// App.connect("monitor-removed", (_s, monitor) => {
	// TODO: Deal with the mirror problem
	// })
}

App.start({
	main() {
		init()
		forMonitors([Bar, NotificationPopups, OSD, ScreenCorners])
		Launcher()
		Overview()
		Settings()
		VerificationPopup()
		PowerMenu()
	},

	requestHandler(request: string, _: (response: any) => void) {
		if (request == "shutdown") powermenu.action("shutdown")
		if (request == "record") scr.recording ? scr.stop() : scr.start()
		if (request == "record-area") scr.recording ? scr.stop() : scr.start(true)
	},
})
