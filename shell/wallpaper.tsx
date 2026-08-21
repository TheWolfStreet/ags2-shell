// Starts the separate process that draws wallpapers on each monitor.

import app from "ags/gtk4/app"
import { createRoot } from "ags"
import { Gdk } from "ags/gtk4"
import { interval } from "ags/time"

import GLib from "gi://GLib"
import { programArgs } from "system"

import env from "$lib/env"
import { basicMonitorKey } from "$lib/windowing"
import { Wallpaper } from "widget/Wallpaper"

function monitorKey(monitor: Gdk.Monitor, index: number) {
	const geometry = monitor.get_geometry()
	return basicMonitorKey(monitor, `${index}:${monitor.get_description() ?? "unknown"}:${geometry.x}x${geometry.y}`)
}

function startWallpaperWindows() {
	const active = new Map<string, { monitor: Gdk.Monitor, retarget: (monitor: Gdk.Monitor) => void, dispose: () => void }>()

	const sync = () => {
		const current = new Map(app.get_monitors().map((monitor, index) => [monitorKey(monitor, index), monitor]))

		for (const [key, slot] of active) {
			const monitor = current.get(key)
			if (!monitor) {
				slot.dispose()
				active.delete(key)
			} else if (monitor !== slot.monitor) {
				slot.retarget(monitor)
				slot.monitor = monitor
			}
		}

		for (const [key, monitor] of current) {
			if (active.has(key)) continue
			let retarget = (_monitor: Gdk.Monitor) => { }
			const dispose = createRoot(dispose => {
				retarget = Wallpaper.Window({ gdkmonitor: monitor }).retarget
				return dispose
			})
			active.set(key, { monitor, retarget, dispose })
		}
	}

	app.connect("notify::monitors", sync)
	app.connect("shutdown", () => {
		for (const slot of active.values()) slot.dispose()
		active.clear()
	})
	sync()
}

const parentPid = programArgs
	.find(arg => arg.startsWith("--parent-pid="))
	?.slice("--parent-pid=".length)

app.start({
	instanceName: `${env.appName}-wallpaper-${parentPid ?? GLib.uuid_string_random()}`,
	main() {
		env.init()
		startWallpaperWindows()

		if (parentPid) {
			const watchdog = interval(1000, () => {
				if (!GLib.file_test(`/proc/${parentPid}`, GLib.FileTest.EXISTS)) app.quit()
			})
			app.connect("shutdown", () => watchdog.cancel())
		}
	},
})
