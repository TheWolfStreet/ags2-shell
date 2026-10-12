import app from "$lib/app"
import { createRoot } from "ags"
import { Gdk } from "ags/gtk4"
import { interval, timeout, type Timer } from "$lib/time"

import GLib from "gi://GLib"
import { programArgs } from "system"

import env from "$lib/env"
import { watch_live_monitors } from "$lib/hyprland"
import { attempt, log_error } from "$lib/result"
import { Wallpaper } from "widget/Wallpaper"

function monitor_key(monitor: Gdk.Monitor, index: number) {
	const geometry = monitor.get_geometry()
	return (
		monitor.get_connector() ??
		`${index}:${monitor.get_description() ?? "unknown"}:${geometry.x}x${geometry.y}`
	)
}

function start_wallpaper_windows() {
	const active = new Map<
		string,
		{
			monitor: Gdk.Monitor
			retarget: (monitor: Gdk.Monitor) => void
			rearrange: () => void
			dispose: () => void
		}
	>()
	let stopped = false
	let rearrange_timer: Timer | null = null

	const sync = (live_connectors: Set<string>) => {
		if (stopped) return
		const current = new Map(
			app
				.get_monitors()
				.filter((monitor) => {
					const connector = monitor.get_connector()
					return connector == null || live_connectors.has(connector)
				})
				.map((monitor, index) => [monitor_key(monitor, index), monitor]),
		)

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
			let retarget: (monitor: Gdk.Monitor) => void = () => {}
			let rearrange = () => {}
			const dispose = createRoot((dispose) => {
				const wallpaper = Wallpaper.Window({ gdkmonitor: monitor })
				retarget = wallpaper.retarget
				rearrange = wallpaper.rearrange
				return dispose
			})
			active.set(key, { monitor, retarget, rearrange, dispose })
		}

		const rearrange = () => {
			for (const slot of active.values()) slot.rearrange()
		}
		rearrange()
		rearrange_timer?.cancel()
		rearrange_timer = timeout(300, () => {
			rearrange_timer = null
			rearrange()
		})
	}

	const stop_watch = watch_live_monitors(sync)
	app.connect("shutdown", () => {
		stopped = true
		rearrange_timer?.cancel()
		stop_watch()
		for (const slot of active.values()) slot.dispose()
		active.clear()
	})
}

const parent_pid = programArgs
	.find((arg) => arg.startsWith("--parent-pid="))
	?.slice("--parent-pid=".length)

app.start({
	instanceName: `${env.appName}-wallpaper-${parent_pid ?? GLib.uuid_string_random()}`,
	main() {
		const initialized = env.init()
		if (
			!log_error(initialized, "wallpaper: Failed to initialize environment")
		) {
			app.quit()
			return
		}
		const started = attempt(start_wallpaper_windows)
		if (!log_error(started, "wallpaper: Failed to start windows")) app.quit()

		if (parent_pid) {
			const watchdog = interval(1000, () => {
				if (!GLib.file_test(`/proc/${parent_pid}`, GLib.FileTest.EXISTS))
					app.quit()
			})
			app.connect("shutdown", () => watchdog.cancel())
		}
	},
})
