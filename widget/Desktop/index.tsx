// Shows desktop icons on each monitor and handles dragging, keyboard input, and the right-click menu.

import app from "ags/gtk4/app"
import { createComputed, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"

import { releaseMonitorWindow } from "$lib/windows"
import { createDrag } from "./Drag"
import { DesktopGrid } from "./Grid"
import { attachKeyboard } from "./Input"
import { createGrid } from "./model"
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
