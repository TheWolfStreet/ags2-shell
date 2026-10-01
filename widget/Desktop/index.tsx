import app from "$lib/app"
import { createBinding, createComputed, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle } from "$lib/time"

import AstalHyprland from "gi://AstalHyprland"

import { schedule_monitor_window_release } from "$lib/windowing"
import { hyprland } from "$lib/hyprland"
import options, { surface_scale, ui_scale } from "$shell/options"

import { attach_desktop_keyboard, DesktopGrid } from "./components/Grid"
import { DesktopContextMenu } from "./components/ContextMenu"
import { create_desktop_drag_controller } from "./DragAndDrop"
import {
	desktop_interaction,
	get_desktop_grid,
	resize_desktop_grid,
	set_desktop_monitors,
} from "./Desktop"
import { get_desktop_icon_metrics, get_grid_metrics } from "./GridGeometry"

function font_size(font: string): number {
	const match = font.trim().match(/(\d+(?:\.\d+)?)\s*$/)
	if (!match) return 11
	const size = Number.parseFloat(match[1])
	return Number.isFinite(size) && size > 0 ? size : 11
}

function match_monitor(
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

function monitor_key(
	monitor: Gdk.Monitor,
	monitors: AstalHyprland.Monitor[],
	geometry = monitor.get_geometry(),
): string {
	const { connector, match } = match_monitor(monitor, monitors, geometry)
	if (match?.name) return `monitor:${match.name.toLowerCase()}`
	if (connector) return `monitor:${connector}`
	return `monitor:${geometry.x}:${geometry.y}:${geometry.width}x${geometry.height}`
}

function desktop_padding() {
	const factor = ui_scale()
	const padding = Math.max(0, Math.floor(options.theme.padding() * factor))
	const font = Math.max(8, Math.floor(font_size(options.font()) * factor))
	const bar = Math.max(24, Math.round(font + padding * 1.6 + 10 * factor))
	let top = 0
	let bottom = 0
	let left = 0

	if (options.bar.position() === "bottom-center") bottom += bar
	else top += bar

	if (
		options.taskbar.location() === "dock" &&
		options.dock.mode() === "static"
	) {
		const scale = surface_scale(options.dock.scale, 0.25) * factor
		const dock = Math.max(
			48,
			Math.round((64 + 4 * 2 + 4 + 4 + 6 * 2 + 2 * 2) * scale) +
				Math.max(0, Math.floor(options.theme.spacing() * factor)),
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
		const hypr_monitors = createBinding(hyprland, "monitors")
		const geometry = createBinding(gdkmonitor, "geometry")
		const id = createComputed(() =>
			monitor_key(gdkmonitor, hypr_monitors() ?? [], geometry()),
		)
		const grid_metrics = createComputed(() => {
			const { geometry: monitor_geometry } = match_monitor(
				gdkmonitor,
				hypr_monitors() ?? [],
				geometry(),
			)
			return get_grid_metrics(
				monitor_geometry.width,
				monitor_geometry.height,
				desktop_padding(),
				get_desktop_icon_metrics(options.desktop.iconSize(), ui_scale()).cellPx,
				ui_scale(),
			)
		})
		const grid = createComputed(() => get_desktop_grid(id()))

		function report_grid(): void {
			resize_desktop_grid(id.peek(), grid_metrics.peek())
		}

		function report_monitors(): void {
			const connected = hypr_monitors.peek() ?? []
			const live = new Set(connected.map((item) => item.name))
			const ids = app.get_monitors()
				.filter((item) => {
					const connector = item.get_connector()
					return connector === null || live.has(connector)
				})
				.map((item) => monitor_key(item, connected))
			set_desktop_monitors(ids, ids[0] ?? id.peek())
		}

		report_grid()
		report_monitors()
		const monitor_model = Gdk.Display.get_default()?.get_monitors()
		const monitor_handler = monitor_model?.connect("items-changed", report_monitors)
		const unsubscribers = [
			grid_metrics.subscribe(report_grid),
			id.subscribe(report_grid),
			hypr_monitors.subscribe(report_monitors),
		]
		const drag = create_desktop_drag_controller(grid)
		const client_added = hyprland.connect("client-added", (self, client) => {
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
			if (monitor_model && monitor_handler) monitor_model.disconnect(monitor_handler)
			unsubscribers.forEach((unsubscribe) => unsubscribe())
			hyprland.disconnect(client_added)
			schedule_monitor_window_release(window)
			window = undefined
		})

		return (
			<window
				$={(self) => {
					window = self
					attach_desktop_keyboard(self, grid)
					desktop_interaction.roots.add(self)
					onCleanup(() => desktop_interaction.roots.delete(self))
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
