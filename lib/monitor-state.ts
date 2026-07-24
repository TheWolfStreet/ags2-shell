// Finds stable monitor names, watches size changes, and moves windows to another monitor.

import { createState, onCleanup } from "ags"
import { Gdk } from "ags/gtk4"

export type MonitorWindowController = {
	park(): void
	retarget(monitor: Gdk.Monitor): void
}

export function basicMonitorKey(monitor: Gdk.Monitor, fallback: string): string {
	return monitor.get_connector() ?? fallback
}

export function trackMonitorGeometry(initialMonitor: Gdk.Monitor) {
	let monitor = initialMonitor
	const [geometry, setGeometry] = createState(initialMonitor.get_geometry())
	const sync = () => setGeometry(monitor.get_geometry())
	let geometryHandler = monitor.connect("notify::geometry", sync)

	onCleanup(() => monitor.disconnect(geometryHandler))

	return {
		geometry,
		retarget(nextMonitor: Gdk.Monitor) {
			if (monitor !== nextMonitor) {
				monitor.disconnect(geometryHandler)
				monitor = nextMonitor
				geometryHandler = monitor.connect("notify::geometry", sync)
			}
			sync()
		},
	}
}
