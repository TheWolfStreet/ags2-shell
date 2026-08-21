// Draws and handles input for a monitor's desktop grid.

import { Accessor, createComputed, createState, For, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import GLib from "gi://GLib"

import type { DesktopFile } from "../FileOperations"
import { DragLayer, type DesktopDragController } from "../DragAndDrop"
import {
	cancelDesktopCut,
	desktopClipboard,
	desktopInteraction,
	openDesktopFiles,
	pasteDesktopFiles,
	removeDesktopFiles,
	setDesktopClipboard,
	type DesktopGridData,
} from "../Desktop"
import {
	findPathsIntersectingRectangle,
	getDesktopIconMetrics,
	slotIndexToRect,
	type SlotRect,
} from "../GridGeometry"
import options from "$shell/options"
import { desktopContextMenu } from "./ContextMenu"
import { DesktopIcon } from "./Icon"

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
const { FILL, START } = Gtk.Align
const EMPTY_PATH_SET = new Set<string>()
const NO_LAYOUT = (_path: string, _widget?: Gtk.Widget): void => {}

type SelectionRectangle = {
	x: number
	y: number
	width: number
	height: number
}

function isInteractiveTarget(widget: Gtk.Widget | null): boolean {
	let current = widget
	while (current) {
		if (current instanceof Gtk.Entry || current.has_css_class?.("desktop-icon"))
			return true
		current = current.get_parent()
	}
	return false
}

function hitInteractiveTarget(
	gesture: Gtk.GestureClick,
	x: number,
	y: number,
): boolean {
	const picked =
		gesture.get_widget()?.pick?.(x, y, Gtk.PickFlags.DEFAULT) ?? null
	return isInteractiveTarget(picked)
}

function keyPressed(monitorId: string, key: number, state: number): boolean {
	if (key === KEY_Shift_L || key === KEY_Shift_R) {
		desktopContextMenu.setShiftHeld(true)
		return false
	}
	if (!options.desktop.enabled.peek()) return false
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
		removeDesktopFiles(paths, {
			permanently: (state & ModifierType.SHIFT_MASK) !== 0,
		})
		return true
	}
	if (control && (key === KEY_c || key === KEY_C)) {
		setDesktopClipboard("copy", paths)
		return true
	}
	if (control && (key === KEY_x || key === KEY_X)) {
		if (paths.length > 0) setDesktopClipboard("cut", paths)
		else void cancelDesktopCut()
		return true
	}
	if (control && (key === KEY_v || key === KEY_V)) {
		void pasteDesktopFiles(monitorId)
		return true
	}
	if (key === KEY_Return) {
		if (paths.length === 1) openDesktopFiles(paths)
		return true
	}
	if (key === KEY_F2) {
		if (paths.length === 1) desktopInteraction.rename.begin(paths[0])
		return true
	}
	return false
}

export function attachDesktopKeyboard(
	window: Gtk.Window,
	grid: Accessor<DesktopGridData>,
): void {
	const controller = new Gtk.EventControllerKey()
	controller.connect("key-pressed", (_self, key, _code, state) =>
		keyPressed(grid.peek().id, key, state),
	)
	controller.connect("key-released", (_self, key) => {
		if (key === KEY_Shift_L || key === KEY_Shift_R)
			desktopContextMenu.setShiftHeld(false)
	})
	window.add_controller(controller)
}

function DesktopInteractions({
	monitor,
	grid,
	drag,
}: {
	monitor: Gdk.Monitor
	grid: Accessor<DesktopGridData>
	drag: DesktopDragController
}) {
	const [selecting, setSelecting] = createState(false)
	const [selectionRectangle, setSelectionRectangle] =
		createState<SelectionRectangle | null>(null)
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

	function selectRectangle(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
	): void {
		const data = grid.peek()
		if (!data.metrics) return
		const next = findPathsIntersectingRectangle(
			data.files,
			data.positions,
			data.metrics,
			x1,
			y1,
			x2,
			y2,
		)
		const current = desktopInteraction.selected.peek()
		if (
			current.length !== next.length ||
			current.some((path, index) => path !== next[index])
		)
			desktopInteraction.select(next)
	}

	return (
		<>
			<Gtk.EventControllerMotion
				onEnter={desktopContextMenu.enterDesktop}
				onMotion={desktopContextMenu.enterDesktop}
				onLeave={desktopContextMenu.leaveDesktop}
			/>
			<Gtk.DropControllerMotion
				onMotion={(_, x, y) => drag.track(x, y)}
				onLeave={drag.leave}
			/>
			<Gtk.GestureClick
				button={BUTTON_PRIMARY}
				onPressed={(gesture, _count, x, y) => {
					if (
						!options.desktop.enabled.peek() ||
						hitInteractiveTarget(gesture, x, y)
					)
						return
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
					if (
						!options.desktop.enabled.peek() ||
						hitInteractiveTarget(gesture, x, y)
					)
						return
					if (desktopInteraction.rename.path.peek())
						desktopInteraction.rename.commit()
					desktopInteraction.select([])
					const shift =
						(gesture.get_current_event_state() & ModifierType.SHIFT_MASK) !== 0
					const widget = gesture.get_widget()
					const root = widget?.get_root()
					const [translated, menuX, menuY] =
						widget && root instanceof Gtk.Widget
							? widget.translate_coordinates(root, x, y)
							: [false, x, y]
					desktopContextMenu.show({
						monitor,
						monitorId: grid.peek().id,
						x: translated ? menuX : x,
						y: translated ? menuY : y,
						shift,
					})
				}}
			/>
			<Gtk.GestureDrag
				button={BUTTON_PRIMARY}
				onDragBegin={(gesture, x, y) => {
					if (
						!options.desktop.enabled.peek() ||
						desktopInteraction.pressed.peek()
					) {
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
						selectRectangle(
							rectangle.x,
							rectangle.y,
							rectangle.x + width,
							rectangle.y + height,
						)
					}
				}}
				onDragEnd={(_gesture, width, height) => {
					setSelecting(false)
					const rectangle = selectionRectangle.peek()
					if (rectangle && (Math.abs(width) > 5 || Math.abs(height) > 5))
						selectRectangle(
							rectangle.x,
							rectangle.y,
							rectangle.x + width,
							rectangle.y + height,
						)
					setSelectionRectangle(null)
					desktopInteraction.redraw()
				}}
			/>
			<box
				$type="overlay"
				visible={createComputed(() => options.desktop.enabled() && selecting())}
				class="selection-rectangle"
				halign={START}
				valign={START}
				marginStart={normalizedRectangle.as((rectangle) => rectangle.x)}
				marginTop={normalizedRectangle.as((rectangle) => rectangle.y)}
				widthRequest={normalizedRectangle.as((rectangle) => rectangle.width)}
				heightRequest={normalizedRectangle.as((rectangle) => rectangle.height)}
			/>
		</>
	)
}

export function DesktopGrid({
	monitor,
	geometry,
	grid,
	drag,
}: {
	monitor: Gdk.Monitor
	geometry: Accessor<Gdk.Rectangle>
	grid: Accessor<DesktopGridData>
	drag: DesktopDragController
}) {
	const widgets = new Map<string, Gtk.Widget>()
	let layoutIcon = NO_LAYOUT
	const selectedPaths = createComputed(() => {
		const selected = desktopInteraction.selected()
		return selected.length > 0 ? new Set(selected) : EMPTY_PATH_SET
	})
	const draggedPaths = createComputed(() => {
		const paths = drag.state().paths
		return paths.length > 0 ? new Set(paths) : EMPTY_PATH_SET
	})
	const cutPaths = createComputed(() => {
		const clipboard = desktopClipboard()
		if (
			!clipboard ||
			clipboard.operation !== "cut" ||
			clipboard.files.length === 0
		)
			return EMPTY_PATH_SET
		return new Set(clipboard.files)
	})
	const iconMetrics = createComputed(() =>
		getDesktopIconMetrics(options.desktop.iconSize(), options.scale() / 100),
	)
	const monitorId = grid.as((data) => data.id)
	const contentHeight = createComputed(() => {
		const metrics = grid().metrics
		return metrics
			? metrics.offsetY +
					metrics.rows * metrics.cellHeight +
					metrics.paddingBottom
			: geometry().height
	})
	const slotRectangles = createComputed(() => {
		const data = grid()
		const rectangles: Record<string, SlotRect> = {}
		if (!data.metrics) return rectangles
		for (const file of data.files) {
			const slotIndex = data.positions[file.path]
			if (slotIndex != null)
				rectangles[file.path] = slotIndexToRect(slotIndex, data.metrics)
		}
		return rectangles
	})

	function registerWidget(path: string, widget: Gtk.Widget): void {
		widgets.set(path, widget)
		layoutIcon(path, widget)
	}

	function unregisterWidget(path: string, widget: Gtk.Widget): void {
		if (widgets.get(path) === widget) widgets.delete(path)
	}

	function bindLayout(fixed: Gtk.Fixed): () => void {
		function placeIcon(widget: Gtk.Widget, rectangle: SlotRect): void {
			widget.set_size_request(rectangle.width, rectangle.height)
			fixed.move(widget, rectangle.x, rectangle.y)
		}

		function applyAllLayouts(): void {
			const rectangles = slotRectangles.peek()
			for (const [path, widget] of widgets) {
				const rectangle = rectangles[path]
				if (rectangle) placeIcon(widget, rectangle)
			}
		}

		layoutIcon = (path, widget) => {
			const icon = widget ?? widgets.get(path)
			const rectangle = icon && slotRectangles.peek()[path]
			if (icon && rectangle) placeIcon(icon, rectangle)
		}
		const unsubscribe = slotRectangles.subscribe(applyAllLayouts)
		applyAllLayouts()
		return unsubscribe
	}

	return (
		<Gtk.ScrolledWindow
			class="desktop-scroll"
			hexpand
			vexpand
			hscrollbarPolicy={Gtk.PolicyType.NEVER}
			vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
		>
			<overlay
				hexpand
				vexpand
				widthRequest={geometry.as((value) => value.width)}
				heightRequest={contentHeight}
			>
				<Gtk.Fixed
					visible={options.desktop.enabled}
					class="desktop-container"
					hexpand
					vexpand
					halign={FILL}
					valign={FILL}
					$={(fixed) => {
						const unbindLayout = bindLayout(fixed)
						drag.attachTarget(fixed)
						onCleanup(() => {
							unbindLayout()
							layoutIcon = NO_LAYOUT
						})
					}}
				>
					<For each={grid.as((data) => data.files)} id={(file) => file.path}>
						{(file: DesktopFile) => (
							<DesktopIcon
								file={file}
								monitor={monitor}
								monitorId={monitorId}
								drag={drag}
								iconMetrics={iconMetrics}
								selectedPaths={selectedPaths}
								draggedPaths={draggedPaths}
								cutPaths={cutPaths}
								registerWidget={registerWidget}
								unregisterWidget={unregisterWidget}
							/>
						)}
					</For>
				</Gtk.Fixed>
				<DesktopInteractions monitor={monitor} grid={grid} drag={drag} />
				<DragLayer $type="overlay" drag={drag} />
			</overlay>
		</Gtk.ScrolledWindow>
	)
}
