// Shows each monitor's desktop grid and wires its menu and input behavior.

import app from "ags/gtk4/app"
import { createBinding, createComputed, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import AstalHyprland from "gi://AstalHyprland"

import { scheduleMonitorWindowRelease } from "$lib/windowing"
import { hyprland } from "$lib/hyprland"
import options from "$shell/options"

import { attachDesktopKeyboard, DesktopGrid } from "./components/Grid"
import { DesktopContextMenu } from "./components/ContextMenu"
import { createDesktopDragController } from "./DragAndDrop"
import {
	desktopInteraction,
	getDesktopGrid,
	resizeDesktopGrid,
	setDesktopMonitors,
} from "./Desktop"
import { getDesktopIconMetrics, getGridMetrics } from "./GridGeometry"

function fontSize(font: string): number {
	const match = font.trim().match(/(\d+(?:\.\d+)?)\s*$/)
	if (!match) return 11
	const size = Number.parseFloat(match[1])
	return Number.isFinite(size) && size > 0 ? size : 11
}

function matchMonitor(
	monitor: Gdk.Monitor,
	monitors: AstalHyprland.Monitor[],
	geometry = monitor.get_geometry(),
) {
	const connector = monitor.get_connector()?.toLowerCase() ?? ""
	const match =
		monitors.find((item) => item.name?.toLowerCase() === connector) ??
		monitors.find(
			(item) =>
				item.x === geometry.x &&
				item.y === geometry.y &&
				item.width === geometry.width &&
				item.height === geometry.height,
		)
	return { connector, geometry, match }
}

function monitorKey(
	monitor: Gdk.Monitor,
	monitors: AstalHyprland.Monitor[],
	geometry = monitor.get_geometry(),
): string {
	const { connector, match } = matchMonitor(monitor, monitors, geometry)
	if (match?.name) return `monitor:${match.name.toLowerCase()}`
	if (connector) return `monitor:${connector}`
	return `monitor:${geometry.x}:${geometry.y}:${geometry.width}x${geometry.height}`
}

function desktopPadding() {
	const uiScale = Math.max(0.1, options.scale() / 100)
	const padding = Math.max(0, Math.floor(options.theme.padding() * uiScale))
	const font = Math.max(8, Math.floor(fontSize(options.font()) * uiScale))
	const bar = Math.max(24, Math.round(font + padding * 1.6 + 10 * uiScale))
	let top = 0
	let bottom = 0
	let left = 0

	if (options.bar.position() === "bottom-center") bottom += bar
	else top += bar

	if (
		options.taskbar.location() === "dock" &&
		options.dock.mode() === "static"
	) {
		const scale = Math.max(0.25, options.dock.scale() / 100) * uiScale
		const dock = Math.max(
			48,
			Math.round((64 + 4 * 2 + 4 + 4 + 6 * 2 + 2 * 2) * scale) +
				Math.max(0, Math.floor(options.theme.spacing() * uiScale)),
		)
		if (options.dock.position() === "center-left") left += dock
		else if (options.dock.position() === "bottom-center") bottom += dock
	}

	return { top, right: 0, bottom, left }
}

export namespace Desktop {
	export const ContextMenuWindow = DesktopContextMenu

	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		let window: Gtk.Window | undefined
		const appMonitors = createBinding(app, "monitors")
		const hyprMonitors = createBinding(hyprland, "monitors")
		const geometry = createBinding(gdkmonitor, "geometry")
		const id = createComputed(() =>
			monitorKey(gdkmonitor, hyprMonitors() ?? [], geometry()),
		)
		const gridMetrics = createComputed(() => {
			const { geometry: monitorGeometry } = matchMonitor(
				gdkmonitor,
				hyprMonitors() ?? [],
				geometry(),
			)
			return getGridMetrics(
				monitorGeometry.width,
				monitorGeometry.height,
				desktopPadding(),
				getDesktopIconMetrics(options.desktop.iconSize(), options.scale() / 100)
					.cellPx,
				options.scale() / 100,
			)
		})
		const grid = createComputed(() => getDesktopGrid(id()))

		function reportGrid(): void {
			resizeDesktopGrid(id.peek(), gridMetrics.peek())
		}

		function reportMonitors(): void {
			const connected = hyprMonitors.peek() ?? []
			const ids = (appMonitors.peek() ?? []).map((item) =>
				monitorKey(item, connected),
			)
			setDesktopMonitors(ids, ids[0] ?? id.peek())
		}

		reportGrid()
		reportMonitors()
		const unsubscribers = [
			gridMetrics.subscribe(reportGrid),
			id.subscribe(reportGrid),
			appMonitors.subscribe(reportMonitors),
			hyprMonitors.subscribe(reportMonitors),
		]
		const drag = createDesktopDragController(grid)
		// Hyprland can leave an ON_DEMAND layer surface focused when a client maps.
		// Hand focus to clients opened beneath the pointer without disabling desktop keys.
		const clientAdded = hyprland.connect("client-added", (_self, client) => {
			idle(() => {
				if (!window?.is_active) return
				const cursor = hyprland.cursorPosition
				if (
					cursor.x >= client.x &&
					cursor.x < client.x + client.width &&
					cursor.y >= client.y &&
					cursor.y < client.y + client.height
				)
					client.focus()
			})
		})
		onCleanup(() => {
			unsubscribers.forEach((unsubscribe) => unsubscribe())
			hyprland.disconnect(clientAdded)
			scheduleMonitorWindowRelease(window)
			window = undefined
		})

		return (
			<window
				$={(self) => {
					window = self
					attachDesktopKeyboard(self, grid)
					desktopInteraction.roots.add(self)
					onCleanup(() => desktopInteraction.roots.delete(self))
				}}
				name="desktop"
				namespace="desktop"
				layer={Astal.Layer.BOTTOM}
				exclusivity={Astal.Exclusivity.IGNORE}
				anchor={TOP | BOTTOM | LEFT | RIGHT}
				application={app}
				gdkmonitor={gdkmonitor}
				visible={options.desktop.enabled}
				keymode={Astal.Keymode.ON_DEMAND}
				css="background: rgba(0,0,0,0.01);"
			>
				<DesktopGrid
					monitor={gdkmonitor}
					geometry={geometry}
					grid={grid}
					drag={drag}
				/>
			</window>
		)
	}

	const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
}
