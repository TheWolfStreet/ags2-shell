import app from "ags/gtk4/app"
import { createComputed, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"

import { releaseMonitorWindow } from "$lib/utils"
import { createDrag } from "./Drag"
import { attachKeyboard, createGrid, DesktopGrid } from "./Grid"
import { DesktopMenu, menu } from "./Menu"
import { session } from "./session"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

export namespace Desktop {
	export const ContextMenuWindow = DesktopMenu

	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		let window: Gtk.Window | undefined
		const grid = createGrid(gdkmonitor)
		const drag = createDrag(grid)
		const keymode = createComputed(() => {
			if (menu.visible() || session.rename.path() || session.selected().length > 0 || session.clipboard()?.operation === "cut")
				return Astal.Keymode.ON_DEMAND
			return Astal.Keymode.NONE
		})

		onCleanup(() => releaseMonitorWindow(window))

		return (
			<window
				$={self => {
					window = self
					attachKeyboard(self, grid)
					session.roots.add(self)
					onCleanup(() => session.roots.delete(self))
				}}
				name="desktop"
				namespace="desktop"
				layer={Astal.Layer.BOTTOM}
				exclusivity={Astal.Exclusivity.IGNORE}
				anchor={TOP | BOTTOM | LEFT | RIGHT}
				application={app}
				gdkmonitor={gdkmonitor}
				visible={session.enabled}
				keymode={keymode}
				css="background: rgba(0,0,0,0.01);"
			>
				<DesktopGrid grid={grid} drag={drag} />
			</window>
		)
	}
}
