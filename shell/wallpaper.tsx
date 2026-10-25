import app from "$lib/app"
import { createRoot } from "ags"
import { Gdk } from "ags/gtk4"
import { interval, timeout, type timer } from "$lib/time"

import GLib from "gi://GLib"
import { programArgs } from "system"

import env from "$lib/env"
import { live_monitors, watch_live_monitors } from "$lib/hyprland"
import { attempt, log_error } from "$lib/result"
import { Wallpaper } from "widget/Wallpaper"

function monitor_key(monitor: Gdk.Monitor, index: number) {
	const geometry = monitor.get_geometry()
	return (
		monitor.get_connector() ??
		`${index}:${monitor.get_description() ?? "unknown"}:${geometry.x}x${geometry.y}`
	)
}

type wallpaper_slot = {
	monitor: Gdk.Monitor
	wallpaper: ReturnType<typeof Wallpaper.Window>
	dispose: () => void
}

function mount_wallpaper(monitor: Gdk.Monitor): wallpaper_slot {
	const [wallpaper, dispose] = createRoot(
		(dispose) => [Wallpaper.Window({ gdkmonitor: monitor }), dispose] as const,
	)
	return { monitor, wallpaper, dispose }
}

function start_wallpaper_windows() {
	const active = new Map<string, wallpaper_slot>()
	let stopped = false
	let rearrange_timer: timer | null = null

	const rearrange = () => {
		for (const slot of active.values()) slot.wallpaper.rearrange()
	}

	const sync = (live_connectors: Set<string>) => {
		if (stopped) return
		const current = new Map(
			live_monitors(live_connectors).map((monitor, index) => [
				monitor_key(monitor, index),
				monitor,
			]),
		)

		for (const [key, slot] of active) {
			const monitor = current.get(key)
			if (!monitor) {
				slot.dispose()
				active.delete(key)
			} else if (monitor !== slot.monitor) {
				slot.wallpaper.retarget(monitor)
				slot.monitor = monitor
			}
		}

		for (const [key, monitor] of current)
			if (!active.has(key)) active.set(key, mount_wallpaper(monitor))

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
	instanceName: `${env.app_name}-wallpaper-${parent_pid ?? GLib.uuid_string_random()}`,
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
