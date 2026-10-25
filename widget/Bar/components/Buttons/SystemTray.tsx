import { createBinding, createComputed, For, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import AstalTray from "gi://AstalTray"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt, type result } from "$lib/result"

import options from "$shell/options"
import { create_tray_menu_popover } from "./tray_menu"

const tray = AstalTray.get_default()

function is_tray_item_visible(item: AstalTray.TrayItem) {
	return (
		!options.bar.systray.ignore().includes(createBinding(item, "title")()) &&
		!!createBinding(item, "gicon")()
	)
}

function menu_address(item: AstalTray.TrayItem) {
	const item_id = item.get_item_id()
	const separator = item_id.indexOf("/")
	const path = (item as unknown as { menuPath: string | null }).menuPath
	if (separator < 0 || !path) return null
	return { bus_name: item_id.slice(0, separator), path }
}

function about_to_show(item: AstalTray.TrayItem, done: () => void) {
	const address = menu_address(item)
	if (!address) {
		console.warn("tray: Invalid menu address")
		done()
		return
	}

	const finish = (outcome: result<unknown>) => {
		if (!outcome.ok) console.warn("tray: AboutToShow failed", outcome.err)
		done()
	}
	const started = attempt(() =>
		Gio.DBus.session.call(
			address.bus_name,
			address.path,
			"com.canonical.dbusmenu",
			"AboutToShow",
			new GLib.Variant("(i)", [0]),
			null,
			Gio.DBusCallFlags.NONE,
			1000,
			null,
			(connection, response) =>
				finish(attempt(() => connection!.call_finish(response))),
		),
	)
	if (!started.ok) finish(started)
}

function TrayItem({ item }: { item: AstalTray.TrayItem }) {
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

	return (
		<button
			class="tray-item"
			visible={visible}
			valign={Gtk.Align.CENTER}
			halign={Gtk.Align.CENTER}
			$={(self) => popover.set_parent(self)}
			tooltipText={createBinding(item, "tooltipText")}
			onClicked={open_menu}
		>
			<Gtk.GestureClick button={Gdk.BUTTON_SECONDARY} onPressed={open_menu} />
			<image gicon={createBinding(item, "gicon")} useFallback />
		</button>
	)
}

export function SystemTray() {
	const tray_items = createBinding(tray, "items")
	const items = createComputed(() => tray_items().filter(is_tray_item_visible))

	return (
		<box visible={items.as((value) => value.length > 0)}>
			<For each={tray_items}>{(item) => <TrayItem item={item} />}</For>
		</box>
	)
}
