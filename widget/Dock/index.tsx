import {
	Accessor,
	createBinding,
	createComputed,
	createState,
	For,
	onCleanup,
} from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import cairo from "cairo"

import { debounce, idle } from "$lib/time"
import {
	schedule_monitor_window_release,
	track_monitor_fullscreen,
} from "$lib/windowing"
import options, { surface_scale, ui_scale } from "$shell/options"
import { PopupWindow, type position } from "widget/shared/PopupWindow"

import {
	create_dock_items,
	render_dock_item,
	side_class,
	type dock_side,
} from "./components/dock_items"
import * as Trash from "./components/trash"

const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { CENTER } = Gtk.Align
const { BOTTOM, LEFT, RIGHT, TOP: top_anchor } = Astal.WindowAnchor
const { TOP } = Astal.Layer
const { EXCLUSIVE, IGNORE } = Astal.Exclusivity

const hotzone_css = "background: rgba(0, 0, 0, 0.01);"
const hide_delay_ms = 250

const side_config: Record<
	dock_side,
	{ anchor: Astal.WindowAnchor; layout: position; orientation: Gtk.Orientation }
> = {
	left: {
		anchor: LEFT | top_anchor | BOTTOM,
		layout: "center-left",
		orientation: VERTICAL,
	},
	bottom: {
		anchor: BOTTOM | LEFT | RIGHT,
		layout: "bottom-center",
		orientation: HORIZONTAL,
	},
}

function limit_input_to(window: Gtk.Window, content: Gtk.Widget) {
	const surface = window.get_surface()
	if (!surface) return
	const [valid, bounds] = content.compute_bounds(window)
	if (!valid) return
	const region = new cairo.Region()
	region.unionRectangle({
		x: Math.floor(bounds.origin.x),
		y: Math.floor(bounds.origin.y),
		width: Math.ceil(bounds.size.width),
		height: Math.ceil(bounds.size.height),
	})
	surface.set_input_region(region)
}

function thickness_request(side: dock_side, thickness: Accessor<number>) {
	return side === "left"
		? { widthRequest: thickness, heightRequest: -1, defaultWidth: 1 }
		: { widthRequest: -1, heightRequest: thickness, defaultHeight: 1 }
}

export function dock_window_thickness(dock_scale: number): number {
	return Math.max(48, Math.round(94 * dock_scale * ui_scale()))
}

export namespace Dock {
	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		const { mode, position, scale } = options.dock
		const dock_side = position.as((value): dock_side =>
			value === "center-left" ? "left" : "bottom",
		)
		const is_autohide = mode.as((value) => value === "autohide")
		const is_static = mode.as((value) => value === "static")
		const is_dock_location = options.taskbar.location.as(
			(value) => value === "dock",
		)
		const shown = track_monitor_fullscreen(gdkmonitor).as((value) => !value)
		const geometry = createBinding(gdkmonitor, "geometry")
		const dock_items = create_dock_items(is_dock_location)
		let release_trash_watcher: (() => void) | null = null
		function sync_trash_watcher() {
			const needed = options.dock.trash.peek()
			if (needed && !release_trash_watcher)
				release_trash_watcher = Trash.acquire_trash_watcher()
			if (!needed && release_trash_watcher) {
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
				dock_side() === "left"
					? monitor_geometry.height
					: monitor_geometry.width
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
			dock_window_thickness(dock_scale()),
		)
		const edge_margin = createComputed(() => Math.round(16 * pixel_scale()))
		const icon_size = createComputed(() =>
			Math.max(16, Math.round(64 * pixel_scale())),
		)
		const dock_class_name = dock_side.as(
			(side) => `dock-container ${side_class(side)}`,
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

		function register_zone(window: Gtk.Window, zone_id: string) {
			windows.push(window)
			const motion = new Gtk.EventControllerMotion()
			motion.connect("enter", () => enter_hover_zone(zone_id))
			motion.connect("leave", () => leave_hover_zone(zone_id))
			window.add_controller(motion)
		}

		function release_hidden_zone(window: Gtk.Window, zone_id: string) {
			if (!window.get_visible()) leave_hover_zone(zone_id)
		}

		function side_active(side: dock_side) {
			return createComputed(
				() =>
					is_dock_location() && dock_items().length > 0 && dock_side() === side,
			)
		}

		function Hotzone({ side }: { side: dock_side }) {
			const active = side_active(side)
			const zone_id = `hotzone-${side}`
			return (
				<window
					$={(self) => register_zone(self, zone_id)}
					name={`dock-hotzone-${side}`}
					layer={TOP}
					exclusivity={IGNORE}
					keymode={Astal.Keymode.NONE}
					focusable={false}
					anchor={side_config[side].anchor}
					visible={createComputed(() => shown() && active() && is_autohide())}
					{...thickness_request(side, hotzone_thickness)}
					gdkmonitor={gdkmonitor}
					css={hotzone_css}
					onNotifyVisible={(self) => release_hidden_zone(self, zone_id)}
				>
					<box class="dock-hotzone" hexpand vexpand css={hotzone_css} />
				</window>
			)
		}

		function DockSurface({ side }: { side: dock_side }) {
			const config = side_config[side]
			const active = side_active(side)
			const zone_id = `dock-${side}`
			let surface_window: Gtk.Window | null = null
			let content: Gtk.Widget | null = null
			const sync_input = () => {
				if (surface_window && content) limit_input_to(surface_window, content)
			}
			const resync = () => idle(sync_input)
			let layout_surface: Gdk.Surface | null = null
			let layout_handler = 0
			const follow_layout = () => {
				const surface = surface_window?.get_surface() ?? null
				if (surface === layout_surface) return
				if (layout_surface) layout_surface.disconnect(layout_handler)
				layout_surface = surface
				layout_handler = surface ? surface.connect("layout", sync_input) : 0
			}
			const unsubscribe_items = dock_items.subscribe(resync)
			const unsubscribe_scale = dock_scale.subscribe(resync)
			onCleanup(() => {
				unsubscribe_items()
				unsubscribe_scale()
				if (layout_surface) layout_surface.disconnect(layout_handler)
				layout_surface = null
			})
			return (
				<PopupWindow
					$={(self) => {
						register_zone(self, zone_id)
						surface_window = self
						self.connect("map", () => {
							follow_layout()
							resync()
						})
					}}
					name={zone_id}
					layer={TOP}
					keymode={Astal.Keymode.NONE}
					focusable={false}
					exclusivity={createComputed(() =>
						active() && is_static() ? EXCLUSIVE : IGNORE,
					)}
					anchor={config.anchor}
					visible={createComputed(
						() => shown() && active() && (is_static() || hovered()),
					)}
					{...thickness_request(side, window_thickness)}
					gdkmonitor={gdkmonitor}
					layout={config.layout}
					handle_closing={false}
					onNotifyVisible={(self) => release_hidden_zone(self, zone_id)}
				>
					<box
						$={(self) => {
							content = self
						}}
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
