// Handles keyboard shortcuts and pointer gestures for desktop icon selection.

import { createComputed, createState } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import GLib from "gi://GLib"

import { desktop } from "$service/Desktop"
import { selectPathsByRectangle } from "$service/Desktop/geometry"
import { isInsideEntry } from "$lib/ui"
import type { DesktopDrag } from "./Drag"
import type { GridModel } from "./model"
import { menu } from "./Menu"
import { session } from "./session"

const {
	BUTTON_PRIMARY,
	BUTTON_SECONDARY,
	KEY_C,
	KEY_Delete,
	KEY_Escape,
	KEY_F2,
	KEY_Return,
	KEY_Shift_L,
	KEY_Shift_R,
	KEY_V,
	KEY_X,
	KEY_c,
	KEY_v,
	KEY_x,
	ModifierType,
} = Gdk
const { START } = Gtk.Align

type SelectionRectangle = { x: number, y: number, width: number, height: number }

function isInsideIcon(widget: Gtk.Widget | null): boolean {
	let current = widget
	while (current) {
		if (current.has_css_class?.("desktop-icon")) return true
		current = current.get_parent()
	}
	return false
}

function hitInteractiveTarget(gesture: Gtk.GestureClick, x: number, y: number): boolean {
	const picked = gesture.get_widget()?.pick?.(x, y, Gtk.PickFlags.DEFAULT) ?? null
	return isInsideIcon(picked) || isInsideEntry(picked)
}

function keyPressed(grid: GridModel, key: number, state: number): boolean {
	if (key === KEY_Shift_L || key === KEY_Shift_R) {
		menu.setShiftHeld(true)
		return false
	}
	if (!session.enabled.peek()) return false
	if (session.rename.path.peek()) {
		if (key === KEY_Escape) {
			session.rename.cancel()
			return true
		}
		return false
	}

	const paths = session.selected.peek()
	const control = (state & ModifierType.CONTROL_MASK) !== 0
	if (key === KEY_Escape) {
		menu.hide()
		return true
	}
	if (key === KEY_Delete) {
		desktop.remove(paths, { permanently: (state & ModifierType.SHIFT_MASK) !== 0 })
		return true
	}
	if (control && (key === KEY_c || key === KEY_C)) {
		desktop.copy(paths)
		return true
	}
	if (control && (key === KEY_x || key === KEY_X)) {
		if (paths.length > 0) desktop.cut(paths)
		else void desktop.cancelCut()
		return true
	}
	if (control && (key === KEY_v || key === KEY_V)) {
		grid.paste()
		return true
	}
	if (key === KEY_Return) {
		if (paths.length === 1) desktop.open(paths)
		return true
	}
	if (key === KEY_F2) {
		if (paths.length === 1) session.rename.begin(paths[0])
		return true
	}
	return false
}

export function attachKeyboard(window: Gtk.Window, grid: GridModel): void {
	const controller = new Gtk.EventControllerKey()
	controller.connect("key-pressed", (_self, key, _code, state) => keyPressed(grid, key, state))
	controller.connect("key-released", (_self, key) => {
		if (key === KEY_Shift_L || key === KEY_Shift_R) menu.setShiftHeld(false)
	})
	window.add_controller(controller)
}

export function DesktopInput({ grid, drag }: { grid: GridModel, drag: DesktopDrag }) {
	const [selecting, setSelecting] = createState(false)
	const [selectionRectangle, setSelectionRectangle] = createState<SelectionRectangle | null>(null)
	const normalizedRectangle = createComputed(() => {
		const rectangle = selectionRectangle()
		if (!rectangle) return { x: 0, y: 0, width: 0, height: 0 }
		return {
			x: Math.min(rectangle.x, rectangle.x + rectangle.width),
			y: Math.min(rectangle.y, rectangle.y + rectangle.height),
			width: Math.abs(rectangle.width),
			height: Math.abs(rectangle.height),
		}
	})
	let lastSelectionSample = 0

	function selectRectangle(x1: number, y1: number, x2: number, y2: number): void {
		const next = selectPathsByRectangle(grid.files.peek(), grid.positions.peek(), grid.metrics.peek(), x1, y1, x2, y2)
		const current = session.selected.peek()
		if (current.length !== next.length || current.some((path, index) => path !== next[index]))
			session.select(next)
	}

	return (
		<>
			<Gtk.EventControllerMotion onEnter={menu.enterDesktop} onMotion={menu.enterDesktop} onLeave={menu.leaveDesktop} />
			<Gtk.DropControllerMotion onMotion={(_, x, y) => drag.track(x, y)} onLeave={drag.leave} />
			<Gtk.GestureClick
				button={BUTTON_PRIMARY}
				onPressed={(gesture, _count, x, y) => {
					if (!session.enabled.peek() || hitInteractiveTarget(gesture, x, y)) return
					if (session.rename.path.peek()) {
						session.rename.commit()
						return
					}
					session.select([])
					menu.hide()
				}}
			/>
			<Gtk.GestureClick
				button={BUTTON_SECONDARY}
				onPressed={(gesture, _count, x, y) => {
					if (!session.enabled.peek() || hitInteractiveTarget(gesture, x, y)) return
					if (session.rename.path.peek()) session.rename.commit()
					session.select([])
					const shift = ((gesture.get_current_event_state?.() ?? 0) & ModifierType.SHIFT_MASK) !== 0
					menu.show({ monitor: grid.monitor, monitorId: grid.id.peek(), x, y, shift })
				}}
			/>
			<Gtk.GestureDrag
				button={BUTTON_PRIMARY}
				onDragBegin={(gesture, x, y) => {
					if (!session.enabled.peek() || session.pressed.peek()) {
						gesture.reset()
						return
					}
					lastSelectionSample = 0
					setSelecting(true)
					setSelectionRectangle({ x, y, width: 0, height: 0 })
					menu.hide()
					selectRectangle(x, y, x, y)
				}}
				onDragUpdate={(_gesture, width, height) => {
					const rectangle = selectionRectangle.peek()
					if (!rectangle) return
					setSelectionRectangle({ ...rectangle, width, height })
					const now = GLib.get_monotonic_time()
					if (now - lastSelectionSample >= 16_000) {
						lastSelectionSample = now
						selectRectangle(rectangle.x, rectangle.y, rectangle.x + width, rectangle.y + height)
					}
				}}
				onDragEnd={(_gesture, width, height) => {
					setSelecting(false)
					const rectangle = selectionRectangle.peek()
					if (rectangle && (Math.abs(width) > 5 || Math.abs(height) > 5))
						selectRectangle(rectangle.x, rectangle.y, rectangle.x + width, rectangle.y + height)
					setSelectionRectangle(null)
					session.redraw()
				}}
			/>
			<box
				$type="overlay"
				visible={createComputed(() => session.enabled() && selecting())}
				class="selection-rectangle"
				halign={START}
				valign={START}
				marginStart={normalizedRectangle.as(rectangle => rectangle.x)}
				marginTop={normalizedRectangle.as(rectangle => rectangle.y)}
				widthRequest={normalizedRectangle.as(rectangle => rectangle.width)}
				heightRequest={normalizedRectangle.as(rectangle => rectangle.height)}
			/>
		</>
	)
}
