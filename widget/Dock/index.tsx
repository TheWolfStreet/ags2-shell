// Shows a dock on each monitor and moves hidden docks to newly connected monitors.

import { createComputed, createState, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import { trackMonitorFullscreen, trackMonitorGeometry, type MonitorWindowController } from "widget/Windowing/MonitorState"
import { scheduleMonitorWindowRelease } from "widget/Windowing/WindowControl"

import * as Trash from "widget/Dock/components/Trash"
import { createDockHoverTracker, createDockItems, createDockSizing } from "widget/Dock/DockBehavior"
import { DockView, DockSurface, Hotzone } from "widget/Dock/components/Surface"

import options from "options"

export namespace Dock {
	export function Window({ gdkmonitor, initialVisible = true }: { gdkmonitor: Gdk.Monitor, initialVisible?: boolean }): MonitorWindowController {
		const { mode } = options.dock
		const isAutohide = mode.as(v => v === "autohide")
		const isStatic = mode.as(v => v === "static")
		const isDockLocation = options.taskbar.location.as(v => v === "dock")

		const [shown, setShown] = createState(initialVisible)
		const fullscreen = trackMonitorFullscreen(gdkmonitor)
		const visible = createComputed(() => shown() && !fullscreen.fullscreen())
		const hover = createDockHoverTracker()
		const monitor = trackMonitorGeometry(gdkmonitor)
		const dockItems = createDockItems(isDockLocation)
		const sizing = createDockSizing(dockItems, monitor.geometry)
		const releaseTrashWatcher = Trash.acquireTrashWatcher()

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

		const controller: MonitorWindowController = {
			park: () => setShown(false),
			retarget(nextMonitor) {
				fullscreen.retarget(nextMonitor)
				for (const window of windows)
					window.set_property("gdkmonitor", nextMonitor)
				monitor.retarget(nextMonitor)
				setShown(true)
			},
		}

		onCleanup(() => {
			releaseTrashWatcher()
			hover.dispose()
			windows.forEach(win => scheduleMonitorWindowRelease(win))
		})

		void (
			<>
				<Hotzone view={view} side="left" />
				<Hotzone view={view} side="bottom" />
				<DockSurface view={view} side="left" />
				<DockSurface view={view} side="bottom" />
			</>
		)

		return controller
	}
}
