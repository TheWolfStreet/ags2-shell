// Tracks a monitor name and work area and updates its desktop icon grid.

import app from "ags/gtk4/app"
import { Accessor, createBinding, createComputed, createState, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import AstalHyprland from "gi://AstalHyprland"

import { desktopController } from "../DesktopController"
import { getDesktopIconMetrics, getGridMetrics, nearestSlotIndexForPoint } from "./GridGeometry"
import type { GridMetrics } from "./GridGeometry"
import type { DesktopFile } from "../FileOperations"
import { hyprland } from "$service/astal"

import options from "options"

export type DesktopGridModel = {
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
	return monitor.get_connector()?.toLowerCase() ?? ""
}

function matchMonitor(monitor: Gdk.Monitor, monitors: AstalHyprland.Monitor[]) {
	const geometry = monitor.get_geometry()
	const connector = connectorName(monitor)
	const match = monitors.find(item => item.name?.toLowerCase() === connector)
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

export function createDesktopGridModel(monitor: Gdk.Monitor): DesktopGridModel {
	const appMonitors = createBinding(app, "monitors")
	const hyprMonitors = createBinding(hyprland, "monitors")
	const geometry = createBinding(monitor, "geometry")
	const id = monitorId(monitor)
	const padding = createComputed(desktopPadding)
	const metrics = createComputed(() => {
		const matchedMonitor = matchMonitor(monitor, hyprMonitors() ?? [])
		const scale = options.scale() / 100
		return getGridMetrics(matchedMonitor.geometry.width, matchedMonitor.geometry.height, padding(), desktopInteraction.iconMetrics().cellPx, scale)
	})
	const files = createComputed(() => desktopController.getGridController(id()).files())
	const positions = createComputed(() => desktopController.getGridController(id()).positions())

	function reportGrid(): void {
		desktopController.getGridController(id.peek()).resize(metrics.peek())
	}

	function reportMonitors(): void {
		const connected = hyprMonitors.peek() ?? []
		const ids = (appMonitors.peek() ?? []).map(item => monitorKey(item, connected))
		desktopController.setMonitors(ids, ids[0] ?? id.peek())
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
		slotAt: (x, y) => nearestSlotIndexForPoint(x, y, metrics.peek()),
		move(paths, anchor, slot) {
			desktopController.getGridController(id.peek()).move({ paths, slot, anchor })
		},
		import(paths, operation) {
			void desktopController.getGridController(id.peek()).import(paths, operation)
		},
		paste() {
			void desktopController.getGridController(id.peek()).paste()
		},
	}
}

const [selected, setSelected] = createState<string[]>([])
const [pressed, setPressed] = createState<string | null>(null)
const [renamePath, setRenamePath] = createState<string | null>(null)
const [renameValue, setRenameValue] = createState("")
const roots = new Set<Gtk.Widget>()

export const desktopInteraction = {
	enabled: options.desktop.enabled,
	iconMetrics: createComputed(() => getDesktopIconMetrics(options.desktop.iconSize(), options.scale() / 100)),
	clipboard: desktopController.clipboard,
	selected,
	pressed,
	select: setSelected,
	press: setPressed,
	redraw() {
		idle(() => roots.forEach(root => root.queue_draw()))
	},
	roots: {
		add(root: Gtk.Widget) {
			roots.add(root)
		},
		delete(root: Gtk.Widget) {
			roots.delete(root)
		},
	},
	rename: {
		path: renamePath,
		value: renameValue,
		setValue: setRenameValue,
		begin(path: string) {
			const name = path.split("/").pop() || ""
			if (renamePath.peek() === path) {
				setRenamePath(null)
				idle(() => {
					setRenameValue(name)
					setRenamePath(path)
				})
			} else {
				setRenameValue(name)
				setRenamePath(path)
			}
			setSelected([path])
		},
		commit() {
			const target = renamePath.peek()
			const name = renameValue.peek().trim()
			if (!target || !name || (target.split("/").pop() || "") === name) {
				setRenamePath(null)
				return
			}

			const path = desktopController.rename(target, name)
			if (path)
				setSelected([path])
			setRenamePath(null)
		},
		cancel() {
			setRenamePath(null)
		},
	},
}
