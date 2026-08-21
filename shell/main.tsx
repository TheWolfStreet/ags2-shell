// Starts services and windows and handles launcher, power, recording, and screenshot requests.

import startShell from "$shell/startup"
import env from "$lib/env"

import app from "ags/gtk4/app"
import { createRoot } from "ags"
import { Gdk } from "ags/gtk4"
import { Process, subprocess } from "ags/process"
import { idle, timeout, Timer } from "ags/time"

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

import { basicMonitorKey } from "$lib/windowing"
import { screenCapture } from "$service/screenCapture"

const deferredRoots: Array<() => void> = []
let wallpaperChild: Process | null = null
let wallpaperRestart: Timer | null = null
let stopping = false

function mountDeferredWindows(build: () => void) {
	deferredRoots.push(
		createRoot((dispose) => {
			build()
			return dispose
		}),
	)
}

function toggleRecording(selectArea: boolean) {
	if (screenCapture.recording) screenCapture.stopRecording()
	else screenCapture.startRecording(selectArea)
}

function wallpaperCommand() {
	const parentArg = `--parent-pid=${GLib.file_read_link("/proc/self")}`
	if (
		typeof WALLPAPER_BIN !== "undefined" &&
		GLib.file_test(WALLPAPER_BIN, GLib.FileTest.IS_EXECUTABLE)
	)
		return [WALLPAPER_BIN, parentArg]

	const sourceRoot = GLib.getenv("AGS2SHELL_STYLES") ?? GLib.get_current_dir()
	const sourceEntry = GLib.build_filenamev([
		sourceRoot,
		"shell",
		"wallpaper.tsx",
	])
	if (!GLib.file_test(sourceEntry, GLib.FileTest.EXISTS)) return null
	return [
		"env",
		"-C",
		sourceRoot,
		"ags",
		"run",
		"--gtk",
		"4",
		"shell/wallpaper.tsx",
		"--",
		parentArg,
	]
}

function startWallpaper() {
	wallpaperRestart = null
	if (stopping || wallpaperChild) return

	const command = wallpaperCommand()
	if (!command) {
		console.error("wallpaper: Could not locate shell/wallpaper.tsx")
		wallpaperRestart = timeout(1000, startWallpaper)
		return
	}

	let lastError = ""
	try {
		const process = subprocess(command, print, (error) => (lastError = error))
		wallpaperChild = process
		process.connect("exit", (_, code, signaled) => {
			if (wallpaperChild !== process) return
			wallpaperChild = null
			if (stopping) return

			const reason = signaled ? `signal ${code}` : `status ${code}`
			console.error(
				`wallpaper: Child exited with ${reason}${lastError ? `: ${lastError}` : ""}`,
			)
			wallpaperRestart = timeout(1000, startWallpaper)
		})
	} catch (error) {
		console.error("wallpaper: Failed to start child", error)
		wallpaperRestart = timeout(1000, startWallpaper)
	}
}

app.start({
	instanceName: env.appName,
	main() {
		startShell().catch((err) => console.error("Startup error:", err))
		startWallpaper()

		const activeMonitorWindows = new Map<
			string,
			{ monitor: Gdk.Monitor; dispose: Array<() => void> }
		>()
		let monitorWindowsStopped = false
		const syncMonitorWindows = () => {
			const current = new Map(
				app.get_monitors().map((monitor) => {
					const geometry = monitor.get_geometry()
					const key = basicMonitorKey(
						monitor,
						`mon-${geometry.x}x${geometry.y}`,
					)
					return [key, monitor] as const
				}),
			)

			for (const [key, windows] of activeMonitorWindows) {
				if (current.get(key) !== windows.monitor) {
					windows.dispose.forEach((dispose) => dispose())
					activeMonitorWindows.delete(key)
				}
			}

			for (const [key, monitor] of current) {
				if (!activeMonitorWindows.has(key)) {
					activeMonitorWindows.set(key, {
						monitor,
						dispose: [
							createRoot((dispose) => {
								Bar({ gdkmonitor: monitor })
								return dispose
							}),
							createRoot((dispose) => {
								Desktop.Window({ gdkmonitor: monitor })
								return dispose
							}),
							createRoot((dispose) => {
								Dock.Window({ gdkmonitor: monitor })
								return dispose
							}),
							createRoot((dispose) => {
								Desktop.ContextMenuWindow({ gdkmonitor: monitor })
								return dispose
							}),
						],
					})
				}
			}
		}

		const monitorHandler = app.connect("notify::monitors", syncMonitorWindows)
		let monitorShutdownHandler = 0
		const cleanupMonitorWindows = () => {
			if (monitorWindowsStopped) return
			monitorWindowsStopped = true
			app.disconnect(monitorHandler)
			if (monitorShutdownHandler) app.disconnect(monitorShutdownHandler)
			for (const windows of activeMonitorWindows.values())
				windows.dispose.forEach((dispose) => dispose())
			activeMonitorWindows.clear()
		}

		monitorShutdownHandler = app.connect("shutdown", cleanupMonitorWindows)
		syncMonitorWindows()

		idle(() => {
			idle(() => {
				mountDeferredWindows(() => {
					DateMenu.Window()
					PowerMenu.Window()
					if (!app.get_window("verification")) PowerMenu.VerificationModal()
					Notifications.Window()
					QuickSettings.Window()
					OSD.Window()
				})
				idle(() => {
					mountDeferredWindows(() => {
						Launcher.Window()
						Overview.Window()
					})
				})
			})
		})
		app.connect("shutdown", () => {
			stopping = true
			wallpaperRestart?.cancel()
			wallpaperRestart = null
			const child = wallpaperChild
			wallpaperChild = null
			child?.kill()
			for (const dispose of deferredRoots.splice(0)) dispose()
		})
	},
	requestHandler(argv: string[], res: (response: string) => void) {
		const [request, ...rest] = argv

		switch (request) {
			case "launcher-search": {
				const query = rest.join(" ")
				if (!app.get_window("launcher"))
					mountDeferredWindows(() => Launcher.Window())
				Launcher.setSearchQuery(query, true)
				break
			}
			case "shutdown":
				if (!app.get_window("verification"))
					mountDeferredWindows(() => PowerMenu.VerificationModal())
				PowerMenu.requestActionConfirmation("shutdown")
				break
			case "record":
				toggleRecording(false)
				break
			case "record-area":
				toggleRecording(true)
				break
			case "screenshot":
				screenCapture.screenshot()
				break
			case "screenshot-area":
				screenCapture.screenshot(true)
				break
			default:
				res(`Unknown request: ${request}`)
				return
		}

		res("Request handled successfully")
	},
})
