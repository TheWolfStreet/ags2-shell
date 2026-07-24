// Draws desktop icons at fixed grid positions and handles selection and dragging layers.

import { createComputed, For, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"

import { slotIndexToRect, type SlotRect } from "../model/GridGeometry"
import type { DesktopFile } from "../FileOperations"
import { DragLayer, type DesktopDragController } from "../interaction/DragAndDrop"
import { DesktopIcon } from "./Icon"
import { DesktopInteractions } from "../interaction/Interactions"
import { desktopInteraction, type DesktopGridModel } from "../model/DesktopState"

const { FILL } = Gtk.Align
const EMPTY_PATH_SET = new Set<string>()
const NO_LAYOUT = (_path: string, _widget?: Gtk.Widget): void => {}

export function DesktopGrid({ grid, drag }: { grid: DesktopGridModel, drag: DesktopDragController }) {
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
		const clipboard = desktopInteraction.clipboard()
		if (!clipboard || clipboard.operation !== "cut" || clipboard.files.length === 0) return EMPTY_PATH_SET
		return new Set(clipboard.files)
	})
	const slotRectangles = createComputed(() => {
		const metrics = grid.metrics()
		const positions = grid.positions()
		const rectangles: Record<string, SlotRect> = {}
		for (const file of grid.files()) {
			const slotIndex = positions[file.path]
			if (slotIndex != null) rectangles[file.path] = slotIndexToRect(slotIndex, metrics)
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
		<overlay
			hexpand
			vexpand
			widthRequest={grid.geometry.as(geometry => geometry.width)}
			heightRequest={grid.geometry.as(geometry => geometry.height)}
		>
			<Gtk.Fixed
				visible={desktopInteraction.enabled}
				class="desktop-container"
				hexpand
				vexpand
				halign={FILL}
				valign={FILL}
				$={fixed => {
					const unbindLayout = bindLayout(fixed)
					drag.attachTarget(fixed)
					onCleanup(() => {
						unbindLayout()
						layoutIcon = NO_LAYOUT
					})
				}}
			>
				<For each={grid.files} id={file => file.path}>
					{(file: DesktopFile) => (
						<DesktopIcon
							file={file}
							grid={grid}
							drag={drag}
							iconMetrics={desktopInteraction.iconMetrics}
							selectedPaths={selectedPaths}
							draggedPaths={draggedPaths}
							cutPaths={cutPaths}
							registerWidget={registerWidget}
							unregisterWidget={unregisterWidget}
						/>
					)}
				</For>
			</Gtk.Fixed>
			<DesktopInteractions grid={grid} drag={drag} />
			<DragLayer $type="overlay" drag={drag} />
		</overlay>
	)
}
