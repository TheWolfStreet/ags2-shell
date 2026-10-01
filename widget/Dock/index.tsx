import app from "$lib/app"
import { Accessor, createComputed, createState, For, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"

import { debounce } from "$lib/time"
import {
	schedule_monitor_window_release,
	track_monitor_fullscreen,
} from "$lib/windowing"
import options, { surface_scale, ui_scale } from "$shell/options"
import { PopupWindow, type Position } from "widget/shared/PopupWindow"

import {
	create_dock_items,
	render_dock_item,
	type DockSide,
} from "./components/DockItems"
import * as Trash from "./components/Trash"

const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { CENTER } = Gtk.Align
const { BOTTOM, LEFT, RIGHT, TOP: TOP_ANCHOR } = Astal.WindowAnchor
const { TOP } = Astal.Layer
const { EXCLUSIVE, IGNORE } = Astal.Exclusivity

const hotzone_bg = "rgba(0, 0, 0, 0.01)"
const hide_delay_ms = 250

const side_config = {
	left: {
		anchor: LEFT | TOP_ANCHOR | BOTTOM,
		layout: "center-left" as Position,
		orientation: VERTICAL,
	},
	bottom: {
		anchor: BOTTOM | LEFT | RIGHT,
		layout: "bottom-center" as Position,
		orientation: HORIZONTAL,
	},
}

function thickness_request(side: DockSide, thickness: Accessor<number>) {
	return side === "left"
		? { widthRequest: thickness, heightRequest: -1 }
		: { widthRequest: -1, heightRequest: thickness }
}

function track_monitor_geometry(monitor: Gdk.Monitor) {
	const [geometry, set_geometry] = createState(monitor.get_geometry())
	const geometry_handler = monitor.connect("notify::geometry", () => {
		set_geometry(monitor.get_geometry())
	})

	onCleanup(() => monitor.disconnect(geometry_handler))
	return geometry
}

export namespace Dock {
	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		const { mode, position, scale } = options.dock
		const dock_side = position.as(
			(value) => (value === "center-left" ? "left" : "bottom") as DockSide,
		)
		const is_autohide = mode.as((value) => value === "autohide")
		const is_static = mode.as((value) => value === "static")
		const is_dock_location = options.taskbar.location.as(
			(value) => value === "dock",
		)
		const shown = track_monitor_fullscreen(gdkmonitor).as((value) => !value)
		const geometry = track_monitor_geometry(gdkmonitor)
		const dock_items = create_dock_items(is_dock_location)
		let release_trash_watcher: (() => void) | null = null
		function sync_trash_watcher() {
			const needed = options.dock.trash.peek()
			if (needed && !release_trash_watcher)
				release_trash_watcher = Trash.acquire_trash_watcher()
			else if (!needed && release_trash_watcher) {
				release_trash_watcher()
				release_trash_watcher = null
			}
		}
		sync_trash_watcher()
		const unsubscribe_trash = options.dock.trash.subscribe(sync_trash_watcher)
		const windows: Gtk.Window[] = []

		const dock_scale = createComputed(() => {
			const requested_scale = surface_scale(scale)
			const item_count = dock_items().length
			if (item_count === 0) return requested_scale

			const monitor_geometry = geometry()
			const monitor_length =
				dock_side() === "left" ? monitor_geometry.height : monitor_geometry.width
			const global_scale_factor = ui_scale()
			const usable_length = monitor_length * 0.88 - 2
			const total_spacing = item_count * 11 * global_scale_factor
			const total_icon_size = item_count * 64 * global_scale_factor
			const scale_that_fits = (usable_length - total_spacing) / total_icon_size

			return Math.max(0.3, Math.min(requested_scale, scale_that_fits))
		})
		const pixel_scale = createComputed(() => dock_scale() * ui_scale())
		const hotzone_thickness = createComputed(() =>
			Math.max(16, Math.round(22 * pixel_scale())),
		)
		const window_thickness = createComputed(() =>
			Math.max(48, Math.round(94 * pixel_scale())),
		)
		const edge_margin = createComputed(() => Math.round(16 * pixel_scale()))
		const icon_size = createComputed(() =>
			Math.max(16, Math.round(64 * pixel_scale())),
		)
		const dock_class_name = createComputed(
			() =>
				`dock-container ${dock_side() === "left" ? "dock-vertical" : "dock-horizontal"} ${position()} dock-${mode()}`,
		)

		const [hovered, set_hovered] = createState(false)
		const hover_zones = new Set<string>()
		const hide = debounce(hide_delay_ms, () => set_hovered(false))

		function enter_hover_zone(zone_id: string) {
			hover_zones.add(zone_id)
			hide.cancel()
			if (!hovered()) set_hovered(true)
		}

		function leave_hover_zone(zone_id: string) {
			hover_zones.delete(zone_id)
			if (hover_zones.size === 0) hide.call()
		}

		function bind_hover_zone(window: Gtk.Window, zone_id: string) {
			const motion = new Gtk.EventControllerMotion()
			motion.connect("enter", () => enter_hover_zone(zone_id))
			motion.connect("leave", () => leave_hover_zone(zone_id))
			window.add_controller(motion)
		}

		function side_active(side: DockSide) {
			return createComputed(
				() => is_dock_location() && dock_items().length > 0 && dock_side() === side,
			)
		}

		function Hotzone({ side }: { side: DockSide }) {
			const active = side_active(side)
			const zone_id = `hotzone-${side}`
			return (
				<window
					$={(self) => {
						windows.push(self)
						bind_hover_zone(self, zone_id)
					}}
					name={`dock-hotzone-${side}`}
					layer={TOP}
					exclusivity={IGNORE}
					keymode={Astal.Keymode.NONE}
					focusable={false}
					anchor={side_config[side].anchor}
					application={app}
					visible={createComputed(() => shown() && active() && is_autohide())}
					{...thickness_request(side, hotzone_thickness)}
					gdkmonitor={gdkmonitor}
					css={`
						background: ${hotzone_bg};
					`}
					onNotifyVisible={(self) => {
						if (!self.get_visible()) leave_hover_zone(zone_id)
					}}
				>
					<box
						class="dock-hotzone"
						hexpand
						vexpand
						css={`
							background: ${hotzone_bg};
						`}
					/>
				</window>
			)
		}

		function DockSurface({ side }: { side: DockSide }) {
			const config = side_config[side]
			const active = side_active(side)
			const zone_id = `dock-${side}`
			return (
				<PopupWindow
					$={(self) => {
						windows.push(self)
						bind_hover_zone(self, zone_id)
					}}
					name={zone_id}
					layer={TOP}
					keymode={Astal.Keymode.NONE}
					focusable={false}
					exclusivity={createComputed(() =>
						active() && is_static() ? EXCLUSIVE : IGNORE,
					)}
					anchor={config.anchor}
					application={app}
					visible={createComputed(
						() => shown() && active() && (is_static() || hovered()),
					)}
					{...thickness_request(side, window_thickness)}
					gdkmonitor={gdkmonitor}
					layout={config.layout}
					handleClosing={false}
					onNotifyVisible={(self) => {
						if (!self.get_visible()) leave_hover_zone(zone_id)
					}}
				>
					<box
						class={dock_class_name}
						css={createComputed(() => `--dock-scale: ${dock_scale()};`)}
						orientation={config.orientation}
						halign={CENTER}
						marginStart={side === "left" ? edge_margin : 0}
						marginBottom={side === "left" ? 0 : edge_margin}
					>
						<For each={dock_items}>
							{(item) => render_dock_item(item, side, icon_size)}
						</For>
					</box>
				</PopupWindow>
			)
		}

		onCleanup(() => {
			unsubscribe_trash()
			release_trash_watcher?.()
			hover_zones.clear()
			hide.cancel()
			windows.forEach((window) => schedule_monitor_window_release(window))
		})

		void (
			<>
				<Hotzone side="left" />
				<Hotzone side="bottom" />
				<DockSurface side="left" />
				<DockSurface side="bottom" />
			</>
		)
	}
}
