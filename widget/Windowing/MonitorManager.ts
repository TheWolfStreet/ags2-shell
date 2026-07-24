// Adds Bar, Dock, and Desktop windows for monitors and removes or reuses them when monitors change.

import { createRoot } from "ags"
import { Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { idle, Timer } from "ags/time"

import { basicMonitorKey, type MonitorWindowController } from "./MonitorState"
import { Bar } from "widget/Bar"
import { Dock } from "widget/Dock"
import { Desktop } from "widget/Desktop"

type MonitorWindowKind = "bar" | "dock" | "desktop" | "context"

type ConstructedWindow = {
	dispose: () => void
	controller?: MonitorWindowController
}

type WindowBuilder = (monitor: Gdk.Monitor, initialVisible: boolean) => MonitorWindowController | undefined

const windowBuilders: Record<MonitorWindowKind, WindowBuilder> = {
	bar: (monitor, initialVisible) => Bar({ gdkmonitor: monitor, initialVisible }),
	dock: (monitor, initialVisible) => Dock.Window({ gdkmonitor: monitor, initialVisible }),
	desktop: monitor => {
		Desktop.Window({ gdkmonitor: monitor })
		return undefined
	},
	context: monitor => {
		Desktop.ContextMenuWindow({ gdkmonitor: monitor })
		return undefined
	},
}

const WINDOW_KINDS: MonitorWindowKind[] = ["bar", "dock", "desktop", "context"]
const POOLABLE_WINDOW_KINDS = new Set<MonitorWindowKind>(["bar", "dock"])

function constructWindow(kind: MonitorWindowKind, monitor: Gdk.Monitor, initialVisible: boolean): ConstructedWindow {
	let controller: MonitorWindowController | undefined
	const dispose = createRoot(disposeRoot => {
		controller = windowBuilders[kind](monitor, initialVisible)
		return disposeRoot
	})
	return { dispose, controller }
}

function monitorKey(monitor: Gdk.Monitor): string {
	const geometry = monitor.get_geometry()
	return basicMonitorKey(monitor, `mon-${geometry.x}x${geometry.y}`)
}

type MonitorBundle = {
	windows: Map<MonitorWindowKind, ConstructedWindow>
	cancelConstruction: () => void
}

export function startMonitorWindows() {
	const activeBundles = new Map<string, MonitorBundle>()
	const spareWindows = new Map<MonitorWindowKind, ConstructedWindow>()
	let knownMonitors = new Map<string, Gdk.Monitor>()
	let stopped = false

	const refillSpares = () => {
		if (stopped) return
		const anchorMonitor = app.get_monitors()[0]
		if (!anchorMonitor) return
		for (const kind of POOLABLE_WINDOW_KINDS)
			if (!spareWindows.has(kind))
				spareWindows.set(kind, constructWindow(kind, anchorMonitor, false))
	}

	const connectMonitor = (monitor: Gdk.Monitor) => {
		const key = monitorKey(monitor)
		if (activeBundles.has(key)) return

		const windows = new Map<MonitorWindowKind, ConstructedWindow>()
		const bundle: MonitorBundle = { windows, cancelConstruction: () => { } }
		activeBundles.set(key, bundle)

		const constructionSteps: Array<() => void> = []
		for (const kind of WINDOW_KINDS) {
			const spare = spareWindows.get(kind)
			if (spare) {
				spareWindows.delete(kind)
				spare.controller?.retarget(monitor)
				windows.set(kind, spare)
			} else {
				constructionSteps.push(() => windows.set(kind, constructWindow(kind, monitor, true)))
			}
		}

		let nextStep = 0
		let cancelled = false
		let constructionTimer: Timer | null = null

		const constructNext = () => {
			constructionTimer = null
			if (cancelled) return
			if (nextStep >= constructionSteps.length) {
				constructionTimer = idle(() => {
					constructionTimer = null
					if (!cancelled) refillSpares()
				})
				return
			}
			constructionSteps[nextStep++]()
			constructionTimer = idle(constructNext)
		}
		constructionTimer = idle(constructNext)

		bundle.cancelConstruction = () => {
			cancelled = true
			constructionTimer?.cancel()
			constructionTimer = null
		}
	}

	const disconnectMonitor = (key: string) => {
		const bundle = activeBundles.get(key)
		if (!bundle) return

		activeBundles.delete(key)
		bundle.cancelConstruction()

		for (const [kind, window] of bundle.windows) {
			if (POOLABLE_WINDOW_KINDS.has(kind) && !spareWindows.has(kind) && window.controller) {
				window.controller.park()
				spareWindows.set(kind, window)
			} else {
				window.dispose()
			}
		}
	}

	const sync = () => {
		const currentMonitors = new Map<string, Gdk.Monitor>()
		for (const monitor of app.get_monitors())
			currentMonitors.set(monitorKey(monitor), monitor)

		for (const [key, knownMonitor] of knownMonitors)
			if (currentMonitors.get(key) !== knownMonitor)
				disconnectMonitor(key)

		for (const [key, monitor] of currentMonitors)
			if (knownMonitors.get(key) !== monitor)
				connectMonitor(monitor)

		knownMonitors = currentMonitors
	}

	const monitorHandler = app.connect("notify::monitors", sync)
	let shutdownHandler = 0
	const cleanup = () => {
		if (stopped) return
		stopped = true
		app.disconnect(monitorHandler)
		if (shutdownHandler) app.disconnect(shutdownHandler)

		for (const bundle of activeBundles.values()) {
			bundle.cancelConstruction()
			for (const window of bundle.windows.values()) window.dispose()
		}
		activeBundles.clear()

		for (const window of spareWindows.values()) window.dispose()
		spareWindows.clear()
		knownMonitors.clear()
	}
	shutdownHandler = app.connect("shutdown", cleanup)
	sync()

	return cleanup
}
