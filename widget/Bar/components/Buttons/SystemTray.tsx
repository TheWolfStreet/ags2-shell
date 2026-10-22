import { createBinding, createComputed, For, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import AstalTray from "gi://AstalTray"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import options from "$shell/options"
import { create_tray_menu_popover } from "./TrayMenu"

const tray = AstalTray.get_default()

export function SystemTray() {
	const tray_items = createBinding(tray, "items")
	const items = createComputed(() => {
		const ignored = new Set(options.bar.systray.ignore())
		return tray_items().filter(
			(item) =>
				!ignored.has(createBinding(item, "title")()) &&
				!!createBinding(item, "gicon")(),
		)
	})

	return (
		<box visible={items.as((value) => value.length > 0)}>
			<For each={tray_items}>
				{(item) => {
					const item_visible = createComputed(
						() =>
							!options.bar.systray
								.ignore()
								.includes(createBinding(item, "title")()) &&
							!!createBinding(item, "gicon")(),
					)
					const { popover, ensure_built } = create_tray_menu_popover(item)
					let pending = false
					let active = true
					onCleanup(() => {
						active = false
					})
					const about_to_show = (done: () => void) => {
						const item_id = item.get_item_id()
						const separator = item_id.indexOf("/")
						const menu_path = (item as unknown as { menuPath: string | null })
							.menuPath
						if (separator < 0 || !menu_path) {
							console.warn("tray: Invalid menu address")
							if (active) done()
							return
						}
						try {
							Gio.DBus.session.call(
								item_id.slice(0, separator),
								menu_path,
								"com.canonical.dbusmenu",
								"AboutToShow",
								new GLib.Variant("(i)", [0]),
								null,
								Gio.DBusCallFlags.NONE,
								1000,
								null,
								(connection, result) => {
									try {
										connection!.call_finish(result)
									} catch (error) {
										console.warn("tray: AboutToShow failed", error)
									}
									if (active) done()
								},
							)
						} catch (error) {
							console.warn("tray: AboutToShow failed", error)
							if (active) done()
						}
					}
					const open_menu = () => {
						if (!item.menuModel || !item_visible.peek() || pending) return
						pending = true
						about_to_show(() => {
							pending = false
							if (!item.menuModel || !item_visible.peek()) return
							ensure_built()
							popover.popup()
						})
					}
					return (
						<button
							class="tray-item"
							visible={item_visible}
							valign={Gtk.Align.CENTER}
							halign={Gtk.Align.CENTER}
							$={(self) => popover.set_parent(self)}
							tooltipText={createBinding(item, "tooltipText")}
							onClicked={open_menu}
						>
							<Gtk.GestureClick
								button={Gdk.BUTTON_SECONDARY}
								onPressed={open_menu}
							/>
							<image gicon={createBinding(item, "gicon")} useFallback />
						</button>
					)
				}}
			</For>
		</box>
	)
}
