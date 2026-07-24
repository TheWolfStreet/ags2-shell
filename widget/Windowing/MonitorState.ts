// Tracks monitor identity, geometry, fullscreen state, and retargetable windows.

import { Accessor, createState, onCleanup } from "ags"
import { Gdk } from "ags/gtk4"

import AstalHyprland from "gi://AstalHyprland"

import { hyprland } from "$service/astal"

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

type MonitorFullscreenState = {
	fullscreen: Accessor<boolean>
	retarget(monitor: Gdk.Monitor): void
}

export function trackMonitorFullscreen(initialMonitor: Gdk.Monitor): MonitorFullscreenState {
	let target = initialMonitor
	const [fullscreen, setFullscreen] = createState(false)

	const findMonitor = () => {
		const connector = target.get_connector()
		const geometry = target.get_geometry()

		return hyprland.monitors.find(monitor => monitor.name === connector)
			?? hyprland.monitors.find(monitor => monitor.x === geometry.x && monitor.y === geometry.y)
	}

	const sync = () => {
		const monitor = findMonitor()
		if (!monitor) {
			setFullscreen(false)
			return
		}

		const specialWorkspace = monitor.specialWorkspace?.id
		const workspace = specialWorkspace && specialWorkspace !== 0
			? specialWorkspace
			: monitor.activeWorkspace?.id

		setFullscreen(typeof workspace === "number" && hyprland.clients.some(client =>
			client.mapped
			&& !client.hidden
			&& client.monitor?.id === monitor.id
			&& client.workspace?.id === workspace
			&& (client.fullscreen === AstalHyprland.Fullscreen.FULLSCREEN
				|| client.fullscreenClient === AstalHyprland.Fullscreen.FULLSCREEN),
		))
	}

	const eventHandler = hyprland.connect("event", sync)
	sync()

	onCleanup(() => hyprland.disconnect(eventHandler))

	return {
		fullscreen,
		retarget(monitor) {
			target = monitor
			sync()
		},
	}
}
