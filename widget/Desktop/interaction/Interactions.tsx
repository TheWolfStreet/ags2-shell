// Handles keyboard shortcuts and pointer gestures for desktop icon selection.

import { createComputed, createState } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import GLib from "gi://GLib"

import { desktopController } from "../DesktopController"
import { findPathsIntersectingRectangle } from "../model/GridGeometry"
import { isInsideEntry } from "$lib/ui"
import type { DesktopDragController } from "./DragAndDrop"
import { desktopInteraction, type DesktopGridModel } from "../model/DesktopState"
import { desktopContextMenu } from "../components/ContextMenu"

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

function keyPressed(grid: DesktopGridModel, key: number, state: number): boolean {
	if (key === KEY_Shift_L || key === KEY_Shift_R) {
		desktopContextMenu.setShiftHeld(true)
		return false
	}
	if (!desktopInteraction.enabled.peek()) return false
	if (desktopInteraction.rename.path.peek()) {
		if (key === KEY_Escape) {
			desktopInteraction.rename.cancel()
			return true
		}
		return false
	}

	const paths = desktopInteraction.selected.peek()
	const control = (state & ModifierType.CONTROL_MASK) !== 0
	if (key === KEY_Escape) {
		desktopContextMenu.hide()
		return true
	}
	if (key === KEY_Delete) {
		desktopController.remove(paths, { permanently: (state & ModifierType.SHIFT_MASK) !== 0 })
		return true
	}
	if (control && (key === KEY_c || key === KEY_C)) {
		desktopController.copy(paths)
		return true
	}
	if (control && (key === KEY_x || key === KEY_X)) {
		if (paths.length > 0) desktopController.cut(paths)
		else void desktopController.cancelCut()
		return true
	}
	if (control && (key === KEY_v || key === KEY_V)) {
		grid.paste()
		return true
	}
	if (key === KEY_Return) {
		if (paths.length === 1) desktopController.open(paths)
		return true
	}
	if (key === KEY_F2) {
		if (paths.length === 1) desktopInteraction.rename.begin(paths[0])
		return true
	}
	return false
}

export function attachDesktopKeyboard(window: Gtk.Window, grid: DesktopGridModel): void {
	const controller = new Gtk.EventControllerKey()
	controller.connect("key-pressed", (_self, key, _code, state) => keyPressed(grid, key, state))
	controller.connect("key-released", (_self, key) => {
		if (key === KEY_Shift_L || key === KEY_Shift_R) desktopContextMenu.setShiftHeld(false)
	})
	window.add_controller(controller)
}

export function DesktopInteractions({ grid, drag }: { grid: DesktopGridModel, drag: DesktopDragController }) {
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
		const next = findPathsIntersectingRectangle(grid.files.peek(), grid.positions.peek(), grid.metrics.peek(), x1, y1, x2, y2)
		const current = desktopInteraction.selected.peek()
		if (current.length !== next.length || current.some((path, index) => path !== next[index]))
			desktopInteraction.select(next)
	}

	return (
		<>
			<Gtk.EventControllerMotion onEnter={desktopContextMenu.enterDesktop} onMotion={desktopContextMenu.enterDesktop} onLeave={desktopContextMenu.leaveDesktop} />
			<Gtk.DropControllerMotion onMotion={(_, x, y) => drag.track(x, y)} onLeave={drag.leave} />
			<Gtk.GestureClick
				button={BUTTON_PRIMARY}
				onPressed={(gesture, _count, x, y) => {
					if (!desktopInteraction.enabled.peek() || hitInteractiveTarget(gesture, x, y)) return
					if (desktopInteraction.rename.path.peek()) {
						desktopInteraction.rename.commit()
						return
					}
					desktopInteraction.select([])
					desktopContextMenu.hide()
				}}
			/>
			<Gtk.GestureClick
				button={BUTTON_SECONDARY}
				onPressed={(gesture, _count, x, y) => {
					if (!desktopInteraction.enabled.peek() || hitInteractiveTarget(gesture, x, y)) return
					if (desktopInteraction.rename.path.peek()) desktopInteraction.rename.commit()
					desktopInteraction.select([])
					const shift = (gesture.get_current_event_state() & ModifierType.SHIFT_MASK) !== 0
					desktopContextMenu.show({ monitor: grid.monitor, monitorId: grid.id.peek(), x, y, shift })
				}}
			/>
			<Gtk.GestureDrag
				button={BUTTON_PRIMARY}
				onDragBegin={(gesture, x, y) => {
					if (!desktopInteraction.enabled.peek() || desktopInteraction.pressed.peek()) {
						gesture.reset()
						return
					}
					lastSelectionSample = 0
					setSelecting(true)
					setSelectionRectangle({ x, y, width: 0, height: 0 })
					desktopContextMenu.hide()
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
					desktopInteraction.redraw()
				}}
			/>
			<box
				$type="overlay"
				visible={createComputed(() => desktopInteraction.enabled() && selecting())}
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
