// Tracks a monitor name and work area and updates its desktop icon grid.

import app from "ags/gtk4/app"
import { Accessor, createBinding, createComputed, onCleanup } from "ags"
import { Gdk } from "ags/gtk4"

import AstalHyprland from "gi://AstalHyprland"

import { desktop } from "$service/Desktop"
import { getGridMetrics, pointToSlotIndex } from "$service/Desktop/geometry"
import type { GridMetrics } from "$service/Desktop/geometry"
import type { DesktopFile } from "$service/Desktop/files"
import { hyprland } from "$service/system"
import { session } from "./session"

import options from "options"

export type GridModel = {
	monitor: Gdk.Monitor
	id: Accessor<string>
	geometry: Accessor<Gdk.Rectangle>
	metrics: Accessor<GridMetrics>
	files: Accessor<DesktopFile[]>
	positions: Accessor<Record<string, number>>
	slotAt(x: number, y: number): number
	move(paths: string[], anchor: string, slot: number): void
	import(paths: string[], operation: "copy" | "move"): void
	paste(): void
}

function fontSize(font: string): number {
	const match = font.trim().match(/(\d+(?:\.\d+)?)\s*$/)
	if (!match) return 11
	const size = Number.parseFloat(match[1])
	return Number.isFinite(size) && size > 0 ? size : 11
}

function connectorName(monitor: Gdk.Monitor): string {
	const getConnector = Reflect.get(monitor, "get_connector")
	if (typeof getConnector !== "function") return ""
	const connector = getConnector.call(monitor)
	return typeof connector === "string" ? connector.toLowerCase() : ""
}

function matchMonitor(monitor: Gdk.Monitor, monitors: AstalHyprland.Monitor[]) {
	const geometry = monitor.get_geometry()
	const connector = connectorName(monitor)
	const match = monitors.find(item => item.name?.toLowerCase?.() === connector)
		?? monitors.find(item => item.x === geometry.x
			&& item.y === geometry.y
			&& item.width === geometry.width
			&& item.height === geometry.height)
	return { connector, geometry, match }
}

function monitorKey(monitor: Gdk.Monitor, monitors: AstalHyprland.Monitor[]): string {
	const { connector, geometry, match } = matchMonitor(monitor, monitors)
	if (match?.name) return `monitor:${match.name.toLowerCase()}`
	if (connector) return `monitor:${connector}`
	return `monitor:${geometry.x}:${geometry.y}:${geometry.width}x${geometry.height}`
}

function desktopPadding() {
	const uiScale = Math.max(0.1, options.scale() / 100)
	const padding = Math.max(0, Math.floor(options.theme.padding() * uiScale))
	const font = Math.max(8, Math.floor(fontSize(options.font()) * uiScale))
	const bar = Math.max(24, Math.round(font + (padding * 1.6) + 10 * uiScale))
	let top = 0
	let bottom = 0
	let left = 0

	if (options.bar.position() === "bottom-center") bottom += bar
	else top += bar

	if (options.taskbar.location() === "dock" && options.dock.mode() === "static") {
		const scale = Math.max(0.25, options.dock.scale() / 100) * uiScale
		const dock = Math.max(48, Math.round((64 + 4 * 2 + 4 + 4 + 6 * 2 + 2 * 2) * scale)
			+ Math.max(0, Math.floor(options.theme.spacing() * uiScale)))
		if (options.dock.position() === "center-left") left += dock
		else if (options.dock.position() === "bottom-center") bottom += dock
	}

	return { top, right: 0, bottom, left }
}

function monitorId(monitor: Gdk.Monitor): Accessor<string> {
	const monitors = createBinding(hyprland, "monitors")
	const geometry = createBinding(monitor, "geometry")
	return createComputed(() => {
		geometry()
		return monitorKey(monitor, monitors() ?? [])
	})
}

export function createGrid(monitor: Gdk.Monitor): GridModel {
	const appMonitors = createBinding(app, "monitors")
	const hyprMonitors = createBinding(hyprland, "monitors")
	const geometry = createBinding(monitor, "geometry")
	const id = monitorId(monitor)
	const padding = createComputed(desktopPadding)
	const metrics = createComputed(() => {
		const matchedMonitor = matchMonitor(monitor, hyprMonitors() ?? [])
		return getGridMetrics(matchedMonitor.geometry.width, matchedMonitor.geometry.height, padding(), session.iconMetrics().cellPx)
	})
	const files = createComputed(() => desktop.grid(id()).files())
	const positions = createComputed(() => desktop.grid(id()).positions())

	function reportGrid(): void {
		desktop.grid(id.peek()).resize(metrics.peek())
	}

	function reportMonitors(): void {
		const connected = hyprMonitors.peek() ?? []
		const ids = (appMonitors.peek() ?? []).map(item => monitorKey(item, connected))
		desktop.setMonitors(ids, ids[0] ?? id.peek())
	}

	reportGrid()
	reportMonitors()
	const unsubscribers = [
		metrics.subscribe(reportGrid),
		id.subscribe(reportGrid),
		appMonitors.subscribe(reportMonitors),
		hyprMonitors.subscribe(reportMonitors),
	]
	onCleanup(() => unsubscribers.forEach(unsubscribe => unsubscribe()))

	return {
		monitor,
		id,
		geometry,
		metrics,
		files,
		positions,
		slotAt: (x, y) => pointToSlotIndex(x, y, metrics.peek()),
		move(paths, anchor, slot) {
			desktop.grid(id.peek()).move({ paths, slot, anchor })
		},
		import(paths, operation) {
			void desktop.grid(id.peek()).import(paths, operation)
		},
		paste() {
			void desktop.grid(id.peek()).paste()
		},
	}
}
