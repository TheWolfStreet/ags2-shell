import start_shell from "$shell/startup"
import env from "$lib/env"

import app from "$lib/app"
import { createRoot } from "ags"
import { Gdk } from "ags/gtk4"
import { Process, subprocess } from "ags/process"
import { idle, timeout, timer } from "$lib/time"

import GLib from "gi://GLib"

import { PowerMenu } from "widget/PowerMenu"
import { Launcher } from "widget/Bar/components/Launcher"
import { Notifications } from "widget/Bar/components/Notifications"
import { QuickSettings } from "widget/Bar/components/QuickSettings"
import { DateMenu } from "widget/Bar/components/DateMenu"
import { OSD } from "widget/OSD"
import { Overview } from "widget/Bar/components/Overview"
import { Bar } from "widget/Bar"
import { Dock } from "widget/Dock"
import { Desktop } from "widget/Desktop"

import { live_monitors, watch_live_monitors } from "$lib/hyprland"
import { screen_capture } from "$service/screen_capture"
import { flush_options } from "$shell/options"
import { attempt, log_error } from "$lib/result"

type monitor_windows = { monitor: Gdk.Monitor; dispose: (() => void)[] }

const deferred_roots: (() => void)[] = []
let wallpaper_child: Process | null = null
let wallpaper_restart: timer | null = null
let wallpaper_failures = 0
let stopping = false
let ready = false
let quitting = false
let startup_failed = false

function mount(build: () => void): () => void {
	return createRoot((dispose) => {
		build()
		return dispose
	})
}

function mount_deferred_windows(build: () => void) {
	deferred_roots.push(mount(build))
}

function mount_monitor_windows(monitor: Gdk.Monitor): monitor_windows {
	return {
		monitor,
		dispose: [
			mount(() => Bar({ gdkmonitor: monitor })),
			mount(() => Desktop.Window({ gdkmonitor: monitor })),
			mount(() => Dock.Window({ gdkmonitor: monitor })),
			mount(() => Desktop.ContextMenuWindow({ gdkmonitor: monitor })),
		],
	}
}

function dispose_monitor_windows(windows: monitor_windows) {
	for (const dispose of windows.dispose) dispose()
}

function monitor_key(monitor: Gdk.Monitor) {
	const geometry = monitor.get_geometry()
	return monitor.get_connector() ?? `mon-${geometry.x}x${geometry.y}`
}

function start_monitor_windows() {
	const active = new Map<string, monitor_windows>()
	let stopped = false
	let shutdown_handler = 0

	const sync = (live_connectors: Set<string>) => {
		const current = new Map(
			live_monitors(live_connectors).map(
				(monitor) => [monitor_key(monitor), monitor] as const,
			),
		)
		for (const [key, windows] of active)
			if (current.get(key) !== windows.monitor) {
				dispose_monitor_windows(windows)
				active.delete(key)
			}
		for (const [key, monitor] of current)
			if (!active.has(key)) active.set(key, mount_monitor_windows(monitor))
	}

	const cleanup = () => {
		if (stopped) return
		stopped = true
		stop_watch()
		if (shutdown_handler) app.disconnect(shutdown_handler)
		for (const windows of active.values()) dispose_monitor_windows(windows)
		active.clear()
	}

	shutdown_handler = app.connect("shutdown", cleanup)
	const stop_watch = watch_live_monitors(sync)
}

function mount_popup_windows() {
	idle(() => {
		idle(() => {
			mount_deferred_windows(() => {
				DateMenu.Window()
				PowerMenu.Window()
				if (!app.get_window("verification")) PowerMenu.VerificationModal()
				Notifications.Window()
				QuickSettings.Window()
				OSD.Window()
			})
			idle(() => {
				mount_deferred_windows(() => {
					Launcher.Window()
					Overview.Window()
				})
			})
		})
	})
}

function stop_shell_children() {
	ready = false
	stopping = true
	wallpaper_restart?.cancel()
	wallpaper_restart = null
	const child = wallpaper_child
	wallpaper_child = null
	if (child)
		log_error(
			attempt(() => child.kill()),
			"wallpaper: Failed to stop child",
		)
	for (const dispose of deferred_roots.splice(0)) dispose()
}

async function take_screenshot(scope: "focused" | "area") {
	const taken = await screen_capture.screenshot({ scope })
	return taken.ok ? taken.value : `Screenshot failed: ${taken.err}`
}

async function toggle_recording(scope: "focused" | "area") {
	if (screen_capture.recording || screen_capture.starting) {
		const stopped = screen_capture.stop_recording()
		return stopped.ok ? "accepted" : `Recording failed: ${stopped.err}`
	}
	const started = await screen_capture.start_recording({ scope })
	return started.ok ? started.value : `Recording failed: ${started.err}`
}

app.before_quit = async () => {
	quitting = true
	try {
		const options = await flush_options()
		if (
			!log_error(options, "shell.quit: Failed to flush options") &&
			!startup_failed
		)
			return false
		const recording = await screen_capture.shutdown()
		log_error(recording, "shell.quit: Failed to stop recorder")
		stopping = true
		return true
	} finally {
		if (!stopping) quitting = false
	}
}

function wallpaper_command() {
	const parent_arg = `--parent-pid=${GLib.file_read_link("/proc/self")}`
	if (
		typeof WALLPAPER_BIN !== "undefined" &&
		GLib.file_test(WALLPAPER_BIN, GLib.FileTest.IS_EXECUTABLE)
	)
		return [WALLPAPER_BIN, parent_arg]

	const source_root = GLib.getenv("AGS2SHELL_STYLES") ?? GLib.get_current_dir()
	const source_entry = GLib.build_filenamev([
		source_root,
		"shell",
		"wallpaper.tsx",
	])
	if (!GLib.file_test(source_entry, GLib.FileTest.EXISTS)) return null
	return [
		"env",
		"-C",
		source_root,
		"ags",
		"run",
		"--gtk",
		"4",
		"shell/wallpaper.tsx",
		"--",
		parent_arg,
	]
}

function schedule_wallpaper_restart() {
	const delay = Math.min(30_000, 1000 * 2 ** wallpaper_failures)
	wallpaper_failures++
	wallpaper_restart = timeout(delay, start_wallpaper)
}

function start_wallpaper() {
	wallpaper_restart = null
	if (stopping || wallpaper_child) return

	const command = wallpaper_command()
	if (!command) {
		console.error("wallpaper: Could not locate shell/wallpaper.tsx")
		schedule_wallpaper_restart()
		return
	}

	const started = attempt(() =>
		subprocess(command, print, (error) =>
			console.error("wallpaper: Child stderr:", error),
		),
	)
	if (!log_error(started, "wallpaper: Failed to start child")) {
		schedule_wallpaper_restart()
		return
	}
	const process = started.value
	const started_at = GLib.get_monotonic_time()
	wallpaper_child = process
	process.connect("exit", (_process, code, signaled) => {
		if (wallpaper_child !== process) return
		wallpaper_child = null
		if (stopping) return

		const reason = signaled ? `signal ${code}` : `status ${code}`
		console.error(`wallpaper: Child exited with ${reason}`)
		if (GLib.get_monotonic_time() - started_at >= 30_000_000)
			wallpaper_failures = 0
		schedule_wallpaper_restart()
	})
}

app.start({
	instanceName: env.app_name,
	async main() {
		const started = start_shell()
		if (!log_error(started, "shell.startup: Failed to initialize")) {
			startup_failed = true
			app.quit()
			return
		}
		start_wallpaper()
		start_monitor_windows()
		mount_popup_windows()
		app.connect("shutdown", stop_shell_children)
		ready = true
	},
	requestHandler(argv: string[], res: (response: string) => void) {
		const [request, ...rest] = argv
		if (!ready || quitting || stopping) {
			res("Shell is starting or stopping")
			return
		}

		switch (request) {
			case "launcher-search": {
				const query = rest.join(" ")
				if (!app.get_window("launcher"))
					mount_deferred_windows(() => Launcher.Window())
				Launcher.set_search_query(query, true)
				break
			}
			case "shutdown":
				if (!app.get_window("verification"))
					mount_deferred_windows(() => PowerMenu.VerificationModal())
				PowerMenu.request_action_confirmation("shutdown")
				break
			case "quit":
				res("accepted")
				timeout(100, () => app.quit())
				return
			case "record":
				void toggle_recording("focused").then(res)
				return
			case "record-area":
				void toggle_recording("area").then(res)
				return
			case "screenshot":
				void take_screenshot("focused").then(res)
				return
			case "screenshot-area":
				void take_screenshot("area").then(res)
				return
			default:
				res(`Unknown request: ${request}`)
				return
		}

		res("accepted")
	},
})
