// Shows desktop icons on each monitor and handles dragging, keyboard input, and the right-click menu.

import app from "ags/gtk4/app"
import { createComputed, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"

import { scheduleMonitorWindowRelease } from "widget/Windowing/WindowControl"
import { createDesktopDragController } from "./interaction/DragAndDrop"
import { DesktopGrid } from "./components/Grid"
import { attachDesktopKeyboard } from "./interaction/Interactions"
import { createDesktopGridModel, desktopInteraction } from "./model/DesktopState"
import { DesktopContextMenu, desktopContextMenu } from "./components/ContextMenu"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

export namespace Desktop {
	export const ContextMenuWindow = DesktopContextMenu

	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		let window: Gtk.Window | undefined
		const grid = createDesktopGridModel(gdkmonitor)
		const drag = createDesktopDragController(grid)
		const keymode = createComputed(() => {
			if (desktopContextMenu.visible() || desktopInteraction.rename.path() || desktopInteraction.selected().length > 0 || desktopInteraction.clipboard()?.operation === "cut")
				return Astal.Keymode.ON_DEMAND
			return Astal.Keymode.NONE
		})

		onCleanup(() => scheduleMonitorWindowRelease(window))

		return (
			<window
				$={self => {
					window = self
					attachDesktopKeyboard(self, grid)
					desktopInteraction.roots.add(self)
					onCleanup(() => desktopInteraction.roots.delete(self))
				}}
				name="desktop"
				namespace="desktop"
				layer={Astal.Layer.BOTTOM}
				exclusivity={Astal.Exclusivity.IGNORE}
				anchor={TOP | BOTTOM | LEFT | RIGHT}
				application={app}
				gdkmonitor={gdkmonitor}
				visible={desktopInteraction.enabled}
				keymode={keymode}
				css="background: rgba(0,0,0,0.01);"
			>
				<DesktopGrid grid={grid} drag={drag} />
			</window>
		)
	}
}
