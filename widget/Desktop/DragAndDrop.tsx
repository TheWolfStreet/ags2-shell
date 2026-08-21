// Handles icon drag data, previews, and drops within or between monitors.

import { Accessor, createState, onCleanup } from "ags"
import GObject from "ags/gobject"
import { Gdk, Gtk } from "ags/gtk4"

import Gio from "gi://Gio"
import Graphene from "gi://Graphene"

import { attempt } from "$lib/result"
import { hiddenDragIcon } from "$lib/textures"
import { hyprland } from "$lib/hyprland"
import options from "$shell/options"
import { buildFileContentProvider } from "./FileOperations"
import {
	desktopInteraction,
	importFilesToDesktop,
	monitorOfDesktopPath,
	moveDesktopFiles,
	type DesktopGridData,
} from "./Desktop"
import { nearestSlotIndexForPoint } from "./GridGeometry"

const { DragAction, ModifierType } = Gdk

type DragState = {
	paths: string[]
	anchor: string | null
	source: string | null
}

type DragPreview = {
	paintable: Gdk.Paintable
	hotspotX: number
	hotspotY: number
	width: number
	height: number
}

type DropPayload = {
	paths: string[]
	operation: "copy" | "move"
}

type Hover = {
	monitorId: string
	x: number
	y: number
}

const EMPTY_DRAG: DragState = { paths: [], anchor: null, source: null }
const [activeDrag, setActiveDrag] = createState<DragState>(EMPTY_DRAG)
const [dragPreview, setDragPreview] = createState<DragPreview | null>(null)
const targets = new Map<
	string,
	(
		paths: string[],
		anchor: string,
		x: number,
		y: number,
		rootCoordinates?: boolean,
	) => void
>()
const dragSession: { handled: boolean; hover: Hover | null } = {
	handled: false,
	hover: null,
}

function decodePath(raw: string) {
	const value = raw.trim()
	if (!value || value.startsWith("#")) return null
	if (value.startsWith("file://")) return Gio.File.new_for_uri(value).get_path()
	return value
}

function parsePayload(value: unknown): DropPayload | null {
	if (typeof value === "string") {
		const lines = value
			.split(/\r?\n/g)
			.map((line) => line.trim())
			.filter(Boolean)
		if (lines.length === 0) return null

		let operation: "copy" | "move" = "move"
		let firstPath = 0
		const first = lines[0].toLowerCase()
		if (first === "copy" || first === "cut" || first === "move") {
			if (first === "copy") operation = "copy"
			firstPath = 1
		}

		const paths = Array.from(
			new Set(
				lines
					.slice(firstPath)
					.map(decodePath)
					.filter((path): path is string => !!path),
			),
		)
		return paths.length > 0 ? { paths, operation } : null
	}

	if (!(value instanceof Gdk.FileList)) return null

	const paths = Array.from(
		new Set(
			value
				.get_files()
				.map((file) => file.get_path())
				.filter(
					(path): path is string => typeof path === "string" && path.length > 0,
				),
		),
	)
	return paths.length > 0 ? { paths, operation: "move" } : null
}

function createPreview(
	widgets: Map<string, Gtk.Widget>,
	paths: string[],
	anchor: string,
	cursorX: number,
	cursorY: number,
) {
	const anchorWidget = widgets.get(anchor)
	if (!anchorWidget) return null

	const previewItems: Array<{
		paintable: Gdk.Paintable
		x: number
		y: number
		width: number
		height: number
	}> = []
	let minX = 0
	let minY = 0
	let maxX = 0
	let maxY = 0

	for (const path of paths) {
		const widget = widgets.get(path)
		if (!widget) continue
		const [ok, x, y] = widget.translate_coordinates(anchorWidget, 0, 0)
		if (!ok) continue

		const live = Gtk.WidgetPaintable.new(widget)
		const paintable = live.get_current_image() ?? live
		const intrinsicWidth = paintable.get_intrinsic_width?.() ?? -1
		const intrinsicHeight = paintable.get_intrinsic_height?.() ?? -1
		const width = Math.max(
			1,
			intrinsicWidth > 0 ? intrinsicWidth : widget.get_width(),
		)
		const height = Math.max(
			1,
			intrinsicHeight > 0 ? intrinsicHeight : widget.get_height(),
		)
		previewItems.push({ paintable, x, y, width, height })
		minX = Math.min(minX, x)
		minY = Math.min(minY, y)
		maxX = Math.max(maxX, x + width)
		maxY = Math.max(maxY, y + height)
	}

	if (previewItems.length === 0) return null

	const width = Math.max(1, maxX - minX)
	const height = Math.max(1, maxY - minY)
	const snapshot = new Gtk.Snapshot()
	snapshot.push_opacity(0.9)
	for (const item of previewItems) {
		snapshot.save()
		snapshot.translate(
			new Graphene.Point({ x: item.x - minX, y: item.y - minY }),
		)
		item.paintable.snapshot(snapshot, item.width, item.height)
		snapshot.restore()
	}
	snapshot.pop()

	const paintable = snapshot.to_paintable(new Graphene.Size({ width, height }))
	if (!paintable) return null
	return {
		paintable,
		hotspotX: -minX + cursorX,
		hotspotY: -minY + cursorY,
		width,
		height,
	}
}

function preferredOperation(
	target: Gtk.DropTarget,
	operation: "copy" | "move",
) {
	if (operation === "copy") return "copy"
	const state = target.get_current_event_state()
	if ((state & ModifierType.CONTROL_MASK) !== 0) return "copy"
	const actions = target.get_current_drop()?.get_actions() ?? 0
	if ((actions & DragAction.MOVE) === 0 && (actions & DragAction.COPY) !== 0)
		return "copy"
	return "move"
}

function dropAction(target: Gtk.DropTarget) {
	if (activeDrag.peek().paths.length > 0) return DragAction.MOVE
	const actions = target.get_current_drop()?.get_actions() ?? 0
	if ((actions & DragAction.COPY) !== 0) return DragAction.COPY
	if ((actions & DragAction.MOVE) !== 0) return DragAction.MOVE
	return 0
}

function attemptCursorDrop(snapshot: DragState) {
	if (snapshot.paths.length === 0 || !snapshot.source) return
	// GTK can finish a cross-monitor drag without delivering the target drop, so resolve it from the cursor.
	const result = attempt(() => {
		const cursor: unknown = JSON.parse(hyprland.message("j/cursorpos"))
		if (!cursor || typeof cursor !== "object") return
		const x = Reflect.get(cursor, "x")
		const y = Reflect.get(cursor, "y")
		if (typeof x !== "number" || typeof y !== "number") return

		for (const monitor of hyprland.monitors ?? []) {
			if (
				x < monitor.x ||
				x >= monitor.x + monitor.width ||
				y < monitor.y ||
				y >= monitor.y + monitor.height
			)
				continue
			const target = `monitor:${monitor.name.toLowerCase()}`
			if (target !== snapshot.source)
				targets.get(target)?.(
					snapshot.paths,
					snapshot.anchor ?? snapshot.paths[0],
					x - monitor.x,
					y - monitor.y,
					true,
				)
			return
		}
	})
	if (!result.ok)
		console.debug(
			"desktop.cursorDrop: Could not resolve the cursor position",
			result.err,
		)
}

export type DesktopDragController = {
	state: Accessor<DragState>
	preview: Accessor<DragPreview | null>
	position: Accessor<{ x: number; y: number }>
	hovered: Accessor<boolean>
	attachSource(widget: Gtk.Widget, path: string, onBegin: () => void): void
	attachTarget(widget: Gtk.Fixed): void
	track(x: number, y: number): void
	leave(): void
}

export function createDesktopDragController(
	grid: Accessor<DesktopGridData>,
): DesktopDragController {
	const [position, setPosition] = createState({ x: 0, y: 0 })
	const [hovered, setHovered] = createState(false)
	const widgets = new Map<string, Gtk.Widget>()
	let targetWidget: Gtk.Fixed | null = null

	function slotAt(x: number, y: number): number {
		const metrics = grid.peek().metrics
		return metrics ? nearestSlotIndexForPoint(x, y, metrics) : 0
	}

	function move(paths: string[], anchor: string, slot: number) {
		moveDesktopFiles(grid.peek().id, paths, slot, anchor)
		desktopInteraction.select(paths)
	}

	function finish(snapshot: DragState, deleteData: boolean) {
		const hover = dragSession.hover
		const hoveredAnotherMonitor =
			deleteData &&
			!dragSession.handled &&
			snapshot.paths.length > 0 &&
			snapshot.source !== null &&
			hover !== null &&
			hover.monitorId !== snapshot.source

		if (hoveredAnotherMonitor) {
			dragSession.handled = true
			targets.get(hover.monitorId)?.(
				snapshot.paths,
				snapshot.anchor ?? snapshot.paths[0],
				hover.x,
				hover.y,
			)
		} else if (!dragSession.handled) attemptCursorDrop(snapshot)

		dragSession.handled = false
		dragSession.hover = null
		desktopInteraction.press(null)
		setActiveDrag(EMPTY_DRAG)
		setDragPreview(null)
		desktopInteraction.redraw()
	}

	function attachSource(widget: Gtk.Widget, path: string, onBegin: () => void) {
		widgets.set(path, widget)
		const source = Gtk.DragSource.new()
		source.set_actions(DragAction.MOVE | DragAction.COPY)
		source.connect("prepare", (controller, x, y) => {
			onBegin()
			const selected = desktopInteraction.selected.peek()
			const paths = selected.includes(path) ? selected : [path]
			controller.set_icon(hiddenDragIcon(), 0, 0)
			setDragPreview(createPreview(widgets, paths, path, x, y))
			dragSession.handled = false
			dragSession.hover = null
			desktopInteraction.select(paths)
			setActiveDrag({ paths, anchor: path, source: grid.peek().id })
			return buildFileContentProvider(paths, "cut")
		})
		source.connect("drag-cancel", () => true)
		source.connect("drag-end", (_source, _drag, deleteData) =>
			finish(activeDrag.peek(), deleteData),
		)
		widget.add_controller(source)
		onCleanup(() => {
			if (widgets.get(path) === widget) widgets.delete(path)
		})
	}

	function attachTarget(widget: Gtk.Fixed) {
		targetWidget = widget
		onCleanup(() => {
			if (targetWidget === widget) targetWidget = null
		})
		widget.add_controller(new Gtk.DropControllerMotion())
		const target = Gtk.DropTarget.new(
			GObject.TYPE_STRING,
			DragAction.MOVE | DragAction.COPY,
		)
		target.set_gtypes([GObject.TYPE_STRING, Gdk.FileList.$gtype])

		const hover = (controller: Gtk.DropTarget, x: number, y: number) => {
			const state = activeDrag.peek()
			const monitorId = grid.peek().id
			if (state.paths.length > 0 && state.source && state.source !== monitorId)
				dragSession.hover = { monitorId, x, y }
			return dropAction(controller)
		}

		target.connect("enter", hover)
		target.connect("motion", (controller, x, y) => {
			setPosition({ x, y })
			setHovered(true)
			return hover(controller, x, y)
		})
		target.connect("drop", (controller, value: unknown, x, y) => {
			const payload = parsePayload(value)
			if (!payload || payload.paths.length === 0) return false

			const state = activeDrag.peek()
			const paths = state.paths.length > 0 ? state.paths : payload.paths
			const activePaths = new Set(state.paths)
			const internal = payload.paths.every(
				(path) => activePaths.has(path) && !!monitorOfDesktopPath(path),
			)
			if (internal) {
				dragSession.handled = true
				setDragPreview(null)
				move(paths, state.anchor ?? payload.paths[0], slotAt(x, y))
			} else {
				void importFilesToDesktop(
					payload.paths,
					grid.peek().id,
					preferredOperation(controller, payload.operation),
				)
			}
			return true
		})
		widget.add_controller(target)
	}

	function registerTarget() {
		const monitorId = grid.peek().id
		targets.set(monitorId, (paths, anchor, x, y, rootCoordinates) => {
			if (rootCoordinates && targetWidget) {
				const root = targetWidget.get_root()
				if (root instanceof Gtk.Widget) {
					const [translated, contentX, contentY] = root.translate_coordinates(
						targetWidget,
						x,
						y,
					)
					if (translated) {
						x = contentX
						y = contentY
					}
				}
			}
			dragSession.handled = true
			setDragPreview(null)
			move(paths, anchor, slotAt(x, y))
		})
		return monitorId
	}

	let registered = registerTarget()
	const unsubscribe = grid.subscribe(() => {
		const monitorId = grid.peek().id
		if (monitorId === registered) return
		targets.delete(registered)
		registered = registerTarget()
	})
	onCleanup(() => {
		unsubscribe()
		targets.delete(registered)
	})

	return {
		state: activeDrag,
		preview: dragPreview,
		position,
		hovered,
		attachSource,
		attachTarget,
		track(x, y) {
			setPosition({ x, y })
			setHovered(true)
		},
		leave() {
			if (dragSession.hover?.monitorId === grid.peek().id)
				dragSession.hover = null
			setHovered(false)
		},
	}
}

export function DragLayer({ drag }: { drag: DesktopDragController }) {
	const picture = new Gtk.Picture({ canTarget: false, visible: false })
	return (
		<Gtk.Fixed
			canTarget={false}
			hexpand
			vexpand
			$={(fixed) => {
				fixed.put(picture, 0, 0)
				const place = () => {
					const ghost = drag.preview.peek()
					if (!options.desktop.enabled() || !ghost || !drag.hovered.peek()) {
						picture.visible = false
						return
					}
					const point = drag.position.peek()
					picture.paintable = ghost.paintable
					picture.widthRequest = ghost.width
					picture.heightRequest = ghost.height
					fixed.move(
						picture,
						Math.round(point.x - ghost.hotspotX),
						Math.round(point.y - ghost.hotspotY),
					)
					picture.visible = true
				}
				place()
				const unsubscribers = [
					drag.position.subscribe(place),
					drag.hovered.subscribe(place),
					drag.preview.subscribe(place),
				]
				onCleanup(() => unsubscribers.forEach((unsubscribe) => unsubscribe()))
			}}
		/>
	)
}
