import {
	type Accessor,
	createBinding,
	createComputed,
	createState,
	For,
	onCleanup,
} from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import AstalTray from "gi://AstalTray"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"

import { hyprland, hyprland_command } from "$lib/hyprland"
import { lua_string } from "$lib/lua"
import { attempt, log_error, ok, type result } from "$lib/result"

import options from "$shell/options"
import { bar_thickness } from "widget/shared/PopupWindow"
import { create_tray_menu_popover } from "./tray_menu"

const tray = AstalTray.get_default()
const xembed_bridge_class = "xembedsniproxy"
const wine_menu_half_width = 60

function is_tray_item_visible(item: AstalTray.TrayItem) {
	return (
		!options.bar.systray.ignore().includes(createBinding(item, "title")()) &&
		!!createBinding(item, "gicon")()
	)
}

type dbus_address = { bus_name: string; path: string }

function item_address(item: AstalTray.TrayItem): dbus_address | null {
	const item_id = item.get_item_id()
	const separator = item_id.indexOf("/")
	if (separator < 0) return null
	return {
		bus_name: item_id.slice(0, separator),
		path: item_id.slice(separator),
	}
}

function menu_address(item: AstalTray.TrayItem): dbus_address | null {
	const address = item_address(item)
	const path = (item as unknown as { menuPath: string | null }).menuPath
	if (!address || !path) return null
	return { bus_name: address.bus_name, path }
}

function call_tray(
	address: dbus_address,
	iface: string,
	method: string,
	args: GLib.Variant,
	done: (outcome: result<unknown>) => void,
) {
	const started = attempt(() =>
		Gio.DBus.session.call(
			address.bus_name,
			address.path,
			iface,
			method,
			args,
			null,
			Gio.DBusCallFlags.NONE,
			1000,
			null,
			(connection, response) =>
				done(attempt(() => connection!.call_finish(response))),
		),
	)
	if (!started.ok) done(started)
}

function about_to_show(item: AstalTray.TrayItem, done: () => void) {
	const address = menu_address(item)
	if (!address) {
		console.warn("tray: Invalid menu address")
		done()
		return
	}
	call_tray(
		address,
		"com.canonical.dbusmenu",
		"AboutToShow",
		new GLib.Variant("(i)", [0]),
		(outcome) => {
			if (!outcome.ok) console.warn("tray: AboutToShow failed", outcome.err)
			done()
		},
	)
}

type point = { x: number; y: number }

function popover_gap() {
	const spacing_pt = options.theme.spacing.peek() * (options.scale.peek() / 100)
	return Math.max(8, Math.round((spacing_pt * 4) / 3))
}

function center_x(anchor: Gtk.Widget, origin: number, fallback: number) {
	const root = anchor.get_root()
	if (!root) return fallback
	const middle = new Graphene.Point({ x: anchor.get_width() / 2, y: 0 })
	const [placed, at] = anchor.compute_point(root, middle)
	return placed ? origin + Math.round(at.x) : fallback
}

function anchor_monitor(anchor: Gtk.Widget) {
	const surface = anchor.get_native()?.get_surface()
	if (!surface) return null
	return Gdk.Display.get_default()?.get_monitor_at_surface(surface) ?? null
}

function edge_below(anchor: Gtk.Widget): point {
	const cursor = hyprland.get_cursor_position()
	const monitor = anchor_monitor(anchor)
	if (!monitor) return { x: cursor.x, y: cursor.y }
	const { x, y, height } = monitor.get_geometry()
	const center = center_x(anchor, x, cursor.x)
	const offset = bar_thickness.peek() + popover_gap()
	if (options.bar.position.peek() === "top-center")
		return { x: center, y: y + offset }
	return { x: center, y: y + height - offset }
}

const dbus_daemon = {
	bus_name: "org.freedesktop.DBus",
	path: "/org/freedesktop/DBus",
}

function owner_pid(bus_name: string): Promise<result<number>> {
	return new Promise((resolve) =>
		call_tray(
			dbus_daemon,
			"org.freedesktop.DBus",
			"GetConnectionUnixProcessID",
			new GLib.Variant("(s)", [bus_name]),
			(outcome) =>
				resolve(
					outcome.ok
						? ok((outcome.value as GLib.Variant).deepUnpack<[number]>()[0])
						: outcome,
				),
		),
	)
}

async function owned_by_bridge(bus_name: string) {
	const pid = await owner_pid(bus_name)
	if (!pid.ok) return false
	const name = attempt(() =>
		new TextDecoder()
			.decode(GLib.file_get_contents(`/proc/${pid.value}/comm`)[1])
			.trim(),
	)
	return name.ok && name.value.replace(/^\./, "") === xembed_bridge_class
}

async function click_point(
	anchor: Gtk.Widget,
	bus_name: string,
): Promise<point> {
	const edge = edge_below(anchor)
	if (!(await owned_by_bridge(bus_name))) return edge
	const at = { x: edge.x - wine_menu_half_width, y: edge.y }
	const window = lua_string(`class:^(${xembed_bridge_class})$`)
	const moved = await hyprland_command(
		`dispatch hl.dsp.window.move({ x = ${at.x}, y = ${at.y}, window = ${window} })`,
	)
	log_error(moved, "tray.bridge: Failed to place the XEmbed bridge")
	return at
}

async function forward_click(
	item: AstalTray.TrayItem,
	method: "Activate" | "ContextMenu",
	anchor: Gtk.Widget,
) {
	const address = item_address(item)
	if (!address) {
		console.warn("tray: Invalid item address")
		return
	}
	const { x, y } = await click_point(anchor, address.bus_name)
	call_tray(
		address,
		"org.kde.StatusNotifierItem",
		method,
		new GLib.Variant("(ii)", [x, y]),
		(outcome) => {
			if (!outcome.ok) console.warn(`tray: ${method} failed`, outcome.err)
		},
	)
}

function themed_icon(
	item: AstalTray.TrayItem,
	theme: Gtk.IconTheme | null,
	theme_revision: Accessor<number>,
) {
	const icon_name = createBinding(item, "iconName")
	const gicon = createBinding(item, "gicon")
	return createComputed(() => {
		theme_revision()
		const name = icon_name()
		if (name && theme?.has_icon(name)) return Gio.ThemedIcon.new(name)
		return gicon()
	})
}

function TrayItem({
	item,
	theme,
	theme_revision,
}: {
	item: AstalTray.TrayItem
	theme: Gtk.IconTheme | null
	theme_revision: Accessor<number>
}) {
	const visible = createComputed(() => is_tray_item_visible(item))
	const { popover, ensure_built } = create_tray_menu_popover(item)
	let pending = false
	let active = true
	onCleanup(() => {
		active = false
	})

	const can_open = () => !!item.menuModel && visible.peek()

	const open_menu = () => {
		if (!can_open() || pending) return
		pending = true
		about_to_show(item, () => {
			if (!active) return
			pending = false
			if (!can_open()) return
			ensure_built()
			popover.popup()
		})
	}

	const primary_click = (button: Gtk.Widget) => {
		if (item.menuModel) {
			open_menu()
			return
		}
		void forward_click(item, "Activate", button)
	}

	const secondary_click = (button: Gtk.Widget | null) => {
		if (item.menuModel) open_menu()
		else if (button) void forward_click(item, "ContextMenu", button)
	}

	return (
		<button
			class="tray-item"
			visible={visible}
			valign={Gtk.Align.CENTER}
			halign={Gtk.Align.CENTER}
			$={(self) => popover.set_parent(self)}
			tooltipText={createBinding(item, "tooltipText")}
			onClicked={primary_click}
		>
			<Gtk.GestureClick
				button={Gdk.BUTTON_SECONDARY}
				onPressed={(gesture) => secondary_click(gesture.get_widget())}
			/>
			<image gicon={themed_icon(item, theme, theme_revision)} useFallback />
		</button>
	)
}

export function SystemTray() {
	const tray_items = createBinding(tray, "items")
	const items = createComputed(() => tray_items().filter(is_tray_item_visible))
	const display = Gdk.Display.get_default()
	const theme = display ? Gtk.IconTheme.get_for_display(display) : null
	const [theme_revision, set_theme_revision] = createState(0)
	const theme_handler = theme?.connect("changed", () =>
		set_theme_revision(theme_revision.peek() + 1),
	)
	onCleanup(() => {
		if (theme_handler) theme?.disconnect(theme_handler)
	})

	return (
		<box visible={items.as((value) => value.length > 0)}>
			<For each={tray_items}>
				{(item) => (
					<TrayItem item={item} theme={theme} theme_revision={theme_revision} />
				)}
			</For>
		</box>
	)
}
