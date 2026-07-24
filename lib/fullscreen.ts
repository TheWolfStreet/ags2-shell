// Checks whether a monitor has a visible fullscreen window.

import { Accessor, createState, onCleanup } from "ags"
import { Gdk } from "ags/gtk4"

import AstalHyprland from "gi://AstalHyprland"

import { hyprland } from "$service/system"

type MonitorFullscreen = {
	fullscreen: Accessor<boolean>
	retarget(monitor: Gdk.Monitor): void
}

export function trackMonitorFullscreen(initial: Gdk.Monitor): MonitorFullscreen {
	let target = initial
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

		const visibleWorkspaces = new Set([
			monitor.activeWorkspace?.id,
			monitor.specialWorkspace?.id,
		].filter((id): id is number => typeof id === "number" && id !== 0))

		setFullscreen(hyprland.clients.some(client =>
			client.mapped
			&& !client.hidden
			&& client.monitor?.id === monitor.id
			&& visibleWorkspaces.has(client.workspace?.id)
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
