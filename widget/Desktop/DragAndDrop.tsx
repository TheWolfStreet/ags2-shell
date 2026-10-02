import { Accessor, createState, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { timeout } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"

import { hidden_drag_icon } from "$lib/textures"
import options from "$shell/options"
import { build_file_content_provider, paths_from_uris, read_file_text, split_payload_lines } from "./FileOperations"
import {
	desktop_interaction,
	import_files_to_desktop,
	monitor_of_desktop_path,
	move_desktop_files,
	type DesktopGridData,
} from "./Desktop"
import { nearest_slot_index_for_point } from "./GridGeometry"

const { DragAction, ModifierType } = Gdk

type drag_state = {
	paths: string[]
	anchor: string | null
	source: string | null
}

type drag_preview = {
	paintable: Gdk.Paintable
	hotspot_x: number
	hotspot_y: number
	width: number
	height: number
}

type hover = {
	monitor_id: string
	x: number
	y: number
}

const empty_drag: drag_state = { paths: [], anchor: null, source: null }
const [active_drag, set_active_drag] = createState<drag_state>(empty_drag)
const [drag_preview, set_drag_preview] = createState<drag_preview | null>(null)
const targets = new Map<
	string,
	(
		paths: string[],
		anchor: string,
		x: number,
		y: number,
		root_coordinates?: boolean,
	) => void
>()
const drag_session: { handled: boolean; canceled: boolean; hover: hover | null } = {
	handled: false,
	canceled: false,
	hover: null,
}

function create_preview(
	widgets: Map<string, Gtk.Widget>,
	paths: string[],
	anchor: string,
	cursor_x: number,
	cursor_y: number,
) {
	const anchor_widget = widgets.get(anchor)
	if (!anchor_widget) return null

	const preview_items: Array<{
		paintable: Gdk.Paintable
		x: number
		y: number
		width: number
		height: number
	}> = []
	let min_x = 0
	let min_y = 0
	let max_x = 0
	let max_y = 0

	for (const path of paths) {
		const widget = widgets.get(path)
		if (!widget) continue
		const [ok, x, y] = widget.translate_coordinates(anchor_widget, 0, 0)
		if (!ok) continue

		const live = Gtk.WidgetPaintable.new(widget)
		const paintable = live.get_current_image() ?? live
		const intrinsic_width = paintable.get_intrinsic_width?.() ?? -1
		const intrinsic_height = paintable.get_intrinsic_height?.() ?? -1
		const width = Math.max(
			1,
			intrinsic_width > 0 ? intrinsic_width : widget.get_width(),
		)
		const height = Math.max(
			1,
			intrinsic_height > 0 ? intrinsic_height : widget.get_height(),
		)
		preview_items.push({ paintable, x, y, width, height })
		min_x = Math.min(min_x, x)
		min_y = Math.min(min_y, y)
		max_x = Math.max(max_x, x + width)
		max_y = Math.max(max_y, y + height)
	}

	if (preview_items.length === 0) return null

	const width = Math.max(1, max_x - min_x)
	const height = Math.max(1, max_y - min_y)
	const snapshot = new Gtk.Snapshot()
	snapshot.push_opacity(0.9)
	for (const item of preview_items) {
		snapshot.save()
		snapshot.translate(
			new Graphene.Point({ x: item.x - min_x, y: item.y - min_y }),
		)
		item.paintable.snapshot(snapshot, item.width, item.height)
		snapshot.restore()
	}
	snapshot.pop()

	const paintable = snapshot.to_paintable(new Graphene.Size({ width, height }))
	if (!paintable) return null
	return {
		paintable,
		hotspot_x: -min_x + cursor_x,
		hotspot_y: -min_y + cursor_y,
		width,
		height,
	}
}

function drop_action(drop: Gdk.Drop, control_held: boolean): Gdk.DragAction {
	const actions = drop.get_actions()
	const internal = active_drag.peek().paths.length > 0
	if (internal && (actions & DragAction.MOVE)) return DragAction.MOVE
	if (control_held && (actions & DragAction.COPY)) return DragAction.COPY
	if (actions & DragAction.MOVE) return DragAction.MOVE
	if (actions & DragAction.COPY) return DragAction.COPY
	return 0
}

export type DesktopDragController = {
	state: Accessor<drag_state>
	preview: Accessor<drag_preview | null>
	position: Accessor<{ x: number; y: number }>
	hovered: Accessor<boolean>
	attach_source(widget: Gtk.Widget, path: string, on_begin: () => void): void
	attach_target(widget: Gtk.Fixed): void
	track(x: number, y: number): void
	leave(): void
}

export function create_desktop_drag_controller(
	grid: Accessor<DesktopGridData>,
): DesktopDragController {
	const [position, set_position] = createState({ x: 0, y: 0 })
	const [hovered, set_hovered] = createState(false)
	const widgets = new Map<string, Gtk.Widget>()
	let target_widget: Gtk.Fixed | null = null

	function slot_at(x: number, y: number): number {
		const metrics = grid.peek().metrics
		return metrics ? nearest_slot_index_for_point(x, y, metrics) : 0
	}

	function move(paths: string[], anchor: string, slot: number) {
		move_desktop_files({ to: grid.peek().id, paths, slot, anchor })
		desktop_interaction.select(paths)
	}

	function finish(snapshot: drag_state, delete_data: boolean) {
		const hover = drag_session.hover
		const hovered_another_monitor =
			delete_data &&
			!drag_session.handled && !drag_session.canceled &&
			snapshot.paths.length > 0 &&
			snapshot.source !== null &&
			hover !== null &&
			hover.monitor_id !== snapshot.source

		if (hovered_another_monitor) {
			drag_session.handled = true
			targets.get(hover.monitor_id)?.(
				snapshot.paths,
				snapshot.anchor ?? snapshot.paths[0],
				hover.x,
				hover.y,
			)
		}

		drag_session.handled = false
		drag_session.canceled = false
		drag_session.hover = null
		desktop_interaction.press(null)
		set_active_drag(empty_drag)
		set_drag_preview(null)
		desktop_interaction.redraw()
	}

	function attach_source(widget: Gtk.Widget, path: string, on_begin: () => void) {
		widgets.set(path, widget)
		const source = Gtk.DragSource.new()
		source.set_actions(DragAction.MOVE | DragAction.COPY)
		source.connect("prepare", (controller, x, y) => {
			on_begin()
			const selected = desktop_interaction.selected.peek()
			const paths = selected.includes(path) ? selected : [path]
			controller.set_icon(hidden_drag_icon(), 0, 0)
			set_drag_preview(create_preview(widgets, paths, path, x, y))
			drag_session.handled = false
			drag_session.canceled = false
			drag_session.hover = null
			desktop_interaction.select(paths)
			set_active_drag({ paths, anchor: path, source: grid.peek().id })
			return build_file_content_provider(paths, "cut")
		})
		source.connect("drag-cancel", () => {
			drag_session.canceled = true
			return true
		})
		source.connect("drag-end", (source, drag, delete_data) =>
			finish(active_drag.peek(), delete_data),
		)
		widget.add_controller(source)
		onCleanup(() => {
			if (widgets.get(path) === widget) widgets.delete(path)
		})
	}

	function attach_target(widget: Gtk.Fixed) {
		target_widget = widget
		onCleanup(() => {
			if (target_widget === widget) target_widget = null
		})
		const target = Gtk.DropTargetAsync.new(
			Gdk.ContentFormats.new_for_gtype(Gdk.FileList.$gtype)
				.union(Gdk.ContentFormats.new(["text/uri-list"])),
			DragAction.MOVE | DragAction.COPY)
		target.connect("accept", (controller, drop) =>
			drop.get_formats().contain_gtype(Gdk.FileList.$gtype) ||
			drop.get_formats().contain_mime_type("text/uri-list"))

		const hover = (controller: Gtk.DropTargetAsync, drop: Gdk.Drop, x: number, y: number) => {
			const state = active_drag.peek()
			const monitor_id = grid.peek().id
			if (state.paths.length > 0 && state.source && state.source !== monitor_id)
				drag_session.hover = { monitor_id: monitor_id, x, y }
			set_position({ x, y })
			set_hovered(true)
			return drop_action(drop, (controller.get_current_event_state() & ModifierType.CONTROL_MASK) !== 0)
		}

		target.connect("drag-enter", hover)
		target.connect("drag-motion", hover)
		target.connect("drag-leave", () => {
			if (drag_session.hover?.monitor_id === grid.peek().id) drag_session.hover = null
			set_hovered(false)
		})
		target.connect("drop", (controller, drop, x, y) => {
			const action = drop_action(drop,
				(controller.get_current_event_state() & ModifierType.CONTROL_MASK) !== 0)
			if (!action) return false
			void (async () => {
				const cancellable = new Gio.Cancellable()
				const deadline = timeout(30_000, () => cancellable.cancel())
				try {
					const [stream] = await drop.read_async(["text/uri-list"], GLib.PRIORITY_DEFAULT, cancellable)
					if (!stream) throw new Error("Drop provided no file URI list")
					const text = await read_file_text(stream, cancellable)
					const paths = [...new Set(paths_from_uris(
						split_payload_lines(text).filter((line) => !line.startsWith("#"))))]
					if (!paths.length) throw new Error("Drop contains no local files")
					const state = active_drag.peek()
					const internal = paths.every((path) =>
						state.paths.includes(path) && !!monitor_of_desktop_path(path))
					if (internal && action === DragAction.MOVE) {
						drag_session.handled = true
						move(state.paths, state.anchor ?? paths[0], slot_at(x, y))
					} else {
						const result = await import_files_to_desktop({
							paths, to: grid.peek().id,
							operation: action === DragAction.COPY ? "copy" : "move",
						})
						if (result.failures.length || !result.createdPaths.length)
							throw new Error("Not all dropped files were transferred")
					}
					set_drag_preview(null)
					drop.finish(action)
				} catch (error) {
					console.error("desktop.drop: Failed to complete drop", error)
					drop.finish(0)
				} finally {
					deadline.cancel()
				}
			})()
			return true
		})
		widget.add_controller(target)
	}

	function register_target() {
		const monitor_id = grid.peek().id
		targets.set(monitor_id, (paths, anchor, x, y, root_coordinates) => {
			if (root_coordinates && target_widget) {
				const root = target_widget.get_root()
				if (root instanceof Gtk.Widget) {
					const [translated, content_x, content_y] = root.translate_coordinates(
						target_widget,
						x,
						y,
					)
					if (translated) {
						x = content_x
						y = content_y
					}
				}
			}
			drag_session.handled = true
			set_drag_preview(null)
			move(paths, anchor, slot_at(x, y))
		})
		return monitor_id
	}

	let registered = register_target()
	const unsubscribe = grid.subscribe(() => {
		const monitor_id = grid.peek().id
		if (monitor_id === registered) return
		targets.delete(registered)
		registered = register_target()
	})
	onCleanup(() => {
		unsubscribe()
		targets.delete(registered)
	})

	return {
		state: active_drag,
		preview: drag_preview,
		position,
		hovered,
		attach_source,
		attach_target,
		track(x, y) {
			set_position({ x, y })
			set_hovered(true)
		},
		leave() {
			if (drag_session.hover?.monitor_id === grid.peek().id)
				drag_session.hover = null
			set_hovered(false)
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
						Math.round(point.x - ghost.hotspot_x),
						Math.round(point.y - ghost.hotspot_y),
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
