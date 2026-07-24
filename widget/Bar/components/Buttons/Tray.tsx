// Lists system tray items and creates their menus when opened.

import { createBinding, createComputed, For } from "ags"
import { Gtk } from "ags/gtk4"

import { tray } from "$service/system"
import options from "options"
import { createTrayMenuPopover } from "./TrayMenu"

export function Tray() {
	const trayItems = createBinding(tray, "items")
	const items = createComputed(() => {
		const ignoreSet = new Set(options.bar.systray.ignore())
		return trayItems().filter(item => !ignoreSet.has(item.get_title()) && item.get_gicon())
	})

	return (
		<box visible={items.as(value => value.length > 0)}>
			<For each={items}>
				{item => {
					const { popover, ensureBuilt } = createTrayMenuPopover(item)
					return (
						<button
							class="tray-item"
							valign={Gtk.Align.CENTER}
							halign={Gtk.Align.CENTER}
							$={self => popover.set_parent(self)}
							onClicked={() => {
								if (item.menuModel) {
									ensureBuilt()
									popover.popup()
								}
							}}
						>
							<image gicon={createBinding(item, "gicon")} useFallback />
						</button>
					)
				}}
			</For>
		</box>
	)
}
