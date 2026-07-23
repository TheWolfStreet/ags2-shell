import { createComputed, createState, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import { releaseMonitorWindow } from "$lib/utils"

import * as Trash from "widget/Dock/components/Trash"
import { createHover } from "widget/Dock/components/hover"
import { createDockItems } from "widget/Dock/components/items"
import { dockSizing } from "widget/Dock/components/sizing"
import { DockView, DockSurface, Hotzone } from "widget/Dock/components/Surface"
import { trackMonitorGeometry, type MonitorControl } from "$lib/monitors"
import { trackMonitorFullscreen } from "$lib/fullscreen"

import options from "options"

export namespace Dock {
	export function Window({ gdkmonitor, control, initialVisible = true }: { gdkmonitor: Gdk.Monitor, control?: Partial<MonitorControl>, initialVisible?: boolean }) {
		const { mode } = options.dock
		const isAutohide = mode.as(v => v === "autohide")
		const isStatic = mode.as(v => v === "static")
		const isDockLocation = options.taskbar.location.as(v => v === "dock")

		const [shown, setShown] = createState(initialVisible)
		const fullscreen = trackMonitorFullscreen(gdkmonitor)
		const visible = createComputed(() => shown() && !fullscreen.fullscreen())
		const hover = createHover()
		const monitor = trackMonitorGeometry(gdkmonitor)
		const dockItems = createDockItems(isDockLocation)
		const sizing = dockSizing(dockItems, monitor.geometry)

		const windows: Gtk.Window[] = []
		const view: DockView = {
			gdkmonitor,
			windows,
			shown: visible,
			hover,
			dockItems,
			isDockLocation,
			isAutohide,
			isStatic,
			...sizing,
		}

		if (control) {
			control.park = () => setShown(false)
			control.unpark = (mon) => {
				fullscreen.retarget(mon)
				for (const w of windows)
					w.set_property("gdkmonitor", mon)
				monitor.retarget(mon)
				setShown(true)
			}
		}

		Trash.ensureWatcherStarted()
		onCleanup(() => {
			Trash.cleanupWatcher()
			hover.destroy()
			windows.forEach(win => releaseMonitorWindow(win))
		})

		return (
			<>
				<Hotzone view={view} side="left" />
				<Hotzone view={view} side="bottom" />
				<DockSurface view={view} side="left" />
				<DockSurface view={view} side="bottom" />
			</>
		) as Gtk.Window
	}
}
