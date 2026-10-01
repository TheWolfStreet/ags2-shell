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
			(item) => !ignored.has(createBinding(item, "title")()) && !!createBinding(item, "gicon")(),
		)
	})

	return (
		<box visible={items.as((value) => value.length > 0)}>
			<For each={tray_items}>
				{(item) => {
					const item_visible = createComputed(() =>
						!options.bar.systray.ignore().includes(createBinding(item, "title")()) &&
						!!createBinding(item, "gicon")(),
					)
					const { popover, ensure_built } = create_tray_menu_popover(item)
					let pending = false
					let active = true
					onCleanup(() => { active = false })
					const request = (iface: string, method: string, parameters: GLib.Variant, done?: () => void) => {
						const item_id = item.get_item_id()
						const separator = item_id.indexOf("/")
						if (separator < 0) {
							console.warn("tray: Invalid item address")
							if (active) done?.()
							return
						}
						try {
							Gio.DBus.session.call(
								item_id.slice(0, separator), item_id.slice(separator), iface,
								method, parameters, null, Gio.DBusCallFlags.NONE, 1000, null,
								(connection, result) => {
									try { connection!.call_finish(result) }
									catch (error) { console.warn(`tray: ${method} failed`, error) }
									if (active) done?.()
								},
							)
						} catch (error) {
							console.warn(`tray: ${method} failed`, error)
							if (active) done?.()
						}
					}
					const open_menu = () => {
						if (!item.menuModel || !item_visible.peek() || pending) return
						pending = true
						request("com.canonical.dbusmenu", "AboutToShow", new GLib.Variant("(i)", [0]), () => {
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
							onClicked={() => item.get_is_menu() ? open_menu() : request(
								"org.kde.StatusNotifierItem", "Activate", new GLib.Variant("(ii)", [0, 0]),
							)}
						>
							<Gtk.GestureClick button={Gdk.BUTTON_SECONDARY} onPressed={open_menu} />
							<image gicon={createBinding(item, "gicon")} useFallback />
						</button>
					)
				}}
			</For>
		</box>
	)
}
