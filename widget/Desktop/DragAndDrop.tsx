import { Accessor, createState, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { timeout } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"

import { attempt_async, err, log_error, ok, type result } from "$lib/result"
import { hidden_drag_icon } from "$lib/textures"
import options from "$shell/options"
import {
	build_file_content_provider,
	read_file_text,
	uri_list_paths,
} from "./file_operations"
import {
	desktop_interaction,
	import_files_to_desktop,
	monitor_of_desktop_path,
	move_desktop_files,
	type desktop_grid_data,
} from "./desktop"
import { nearest_slot_index_for_point } from "./grid_geometry"

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

type preview_item = {
	paintable: Gdk.Paintable
	x: number
	y: number
	width: number
	height: number
}

type drag_session = {
	handled: boolean
	canceled: boolean
	hover: hover | null
}

const empty_drag: drag_state = { paths: [], anchor: null, source: null }
const [active_drag, set_active_drag] = createState<drag_state>(empty_drag)
const [drag_preview, set_drag_preview] = createState<drag_preview | null>(null)
const targets = new Map<
	string,
	(paths: string[], anchor: string, x: number, y: number) => void
>()
const session: drag_session = { handled: false, canceled: false, hover: null }

function reset_session(): void {
	session.handled = false
	session.canceled = false
	session.hover = null
}

function size_or(intrinsic: number | undefined, allocated: number): number {
	const size = intrinsic ?? -1
	return Math.max(1, size > 0 ? size : allocated)
}

function preview_item(
	widget: Gtk.Widget,
	anchor_widget: Gtk.Widget,
): preview_item | null {
	const [translated, x, y] = widget.translate_coordinates(anchor_widget, 0, 0)
	if (!translated) return null
	const live = Gtk.WidgetPaintable.new(widget)
	const paintable = live.get_current_image() ?? live
	return {
		paintable,
		x,
		y,
		width: size_or(paintable.get_intrinsic_width?.(), widget.get_width()),
		height: size_or(paintable.get_intrinsic_height?.(), widget.get_height()),
	}
}

function compose_preview(
	items: preview_item[],
	origin_x: number,
	origin_y: number,
	width: number,
	height: number,
): Gdk.Paintable | null {
	const snapshot = new Gtk.Snapshot()
	snapshot.push_opacity(0.9)
	for (const item of items) {
		snapshot.save()
		snapshot.translate(
			new Graphene.Point({ x: item.x - origin_x, y: item.y - origin_y }),
		)
		item.paintable.snapshot(snapshot, item.width, item.height)
		snapshot.restore()
	}
	snapshot.pop()
	return snapshot.to_paintable(new Graphene.Size({ width, height }))
}

function create_preview(
	widgets: Map<string, Gtk.Widget>,
	paths: string[],
	anchor: string,
	cursor_x: number,
	cursor_y: number,
): drag_preview | null {
	const anchor_widget = widgets.get(anchor)
	if (!anchor_widget) return null

	const items: preview_item[] = []
	for (const path of paths) {
		const widget = widgets.get(path)
		if (!widget) continue
		const item = preview_item(widget, anchor_widget)
		if (item) items.push(item)
	}
	if (items.length === 0) return null

	const min_x = Math.min(0, ...items.map((item) => item.x))
	const min_y = Math.min(0, ...items.map((item) => item.y))
	const max_x = Math.max(0, ...items.map((item) => item.x + item.width))
	const max_y = Math.max(0, ...items.map((item) => item.y + item.height))
	const width = Math.max(1, max_x - min_x)
	const height = Math.max(1, max_y - min_y)
	const paintable = compose_preview(items, min_x, min_y, width, height)
	if (!paintable) return null
	return {
		paintable,
		hotspot_x: -min_x + cursor_x,
		hotspot_y: -min_y + cursor_y,
		width,
		height,
	}
}

function control_held(controller: Gtk.EventController): boolean {
	return (
		(controller.get_current_event_state() & ModifierType.CONTROL_MASK) !== 0
	)
}

function drop_action(drop: Gdk.Drop, control: boolean): Gdk.DragAction {
	const actions = drop.get_actions()
	const internal = active_drag.peek().paths.length > 0
	if (internal && actions & DragAction.MOVE) return DragAction.MOVE
	if (control && actions & DragAction.COPY) return DragAction.COPY
	if (actions & DragAction.MOVE) return DragAction.MOVE
	if (actions & DragAction.COPY) return DragAction.COPY
	return 0
}

export type desktop_drag_controller = {
	state: Accessor<drag_state>
	preview: Accessor<drag_preview | null>
	position: Accessor<{ x: number; y: number }>
	hovered: Accessor<boolean>
	attach_source(widget: Gtk.Widget, path: string, on_begin: () => void): void
	attach_target(widget: Gtk.Fixed): void
	track(x: number, y: number): void
	leave(): void
}

async function read_drop_paths(
	drop: Gdk.Drop,
	cancellable: Gio.Cancellable,
): Promise<result<string[]>> {
	const opened = await attempt_async(() =>
		drop.read_async(["text/uri-list"], GLib.PRIORITY_DEFAULT, cancellable),
	)
	if (!opened.ok) return opened

	const [stream] = opened.value
	if (!stream) return err(new Error("Drop provided no file URI list"))

	const text = await read_file_text(stream, cancellable)
	if (!text.ok) return text
	return ok([...new Set(uri_list_paths(text.value))])
}

export function create_desktop_drag_controller(
	grid: Accessor<desktop_grid_data>,
): desktop_drag_controller {
	const [position, set_position] = createState({ x: 0, y: 0 })
	const [hovered, set_hovered] = createState(false)
	const widgets = new Map<string, Gtk.Widget>()
	const unsubscribe_drag = active_drag.subscribe(() => set_hovered(false))
	onCleanup(unsubscribe_drag)

	function slot_at(x: number, y: number): number {
		const metrics = grid.peek().metrics
		return metrics ? nearest_slot_index_for_point(x, y, metrics) : 0
	}

	function move(paths: string[], anchor: string, slot: number) {
		move_desktop_files({ to: grid.peek().id, paths, slot, anchor })
		desktop_interaction.select(paths)
	}

	function unhandled_foreign_hover(
		snapshot: drag_state,
		delete_data: boolean,
	): hover | null {
		const hover = session.hover
		if (!delete_data || session.handled || session.canceled) return null
		if (snapshot.paths.length === 0 || snapshot.source === null) return null
		if (hover === null || hover.monitor_id === snapshot.source) return null
		return hover
	}

	function finish(snapshot: drag_state, delete_data: boolean) {
		const hover = unhandled_foreign_hover(snapshot, delete_data)
		if (hover)
			targets.get(hover.monitor_id)?.(
				snapshot.paths,
				snapshot.anchor ?? snapshot.paths[0],
				hover.x,
				hover.y,
			)

		reset_session()
		desktop_interaction.press(null)
		set_active_drag(empty_drag)
		set_drag_preview(null)
		desktop_interaction.redraw()
	}

	function attach_source(
		widget: Gtk.Widget,
		path: string,
		on_begin: () => void,
	) {
		widgets.set(path, widget)
		const source = Gtk.DragSource.new()
		source.set_actions(DragAction.MOVE | DragAction.COPY)
		source.connect("prepare", (controller, x, y) => {
			const selected = desktop_interaction.selected.peek()
			const paths = selected.includes(path) ? selected : [path]
			set_drag_preview(null)
			controller.set_icon(hidden_drag_icon(), 0, 0)
			const preview = create_preview(widgets, paths, path, x, y)
			on_begin()
			reset_session()
			desktop_interaction.select(paths)
			set_active_drag({ paths, anchor: path, source: grid.peek().id })
			set_drag_preview(preview)
			return build_file_content_provider({ paths, operation: "cut" })
		})
		source.connect("drag-cancel", () => {
			session.canceled = true
			set_drag_preview(null)
			set_active_drag({ ...active_drag.peek() })
			return true
		})
		source.connect("drag-end", (_source, _drag, delete_data) =>
			finish(active_drag.peek(), delete_data),
		)
		widget.add_controller(source)
		onCleanup(() => {
			if (widgets.get(path) === widget) widgets.delete(path)
		})
	}

	async function place_drop(
		drop: Gdk.Drop,
		action: Gdk.DragAction,
		x: number,
		y: number,
		cancellable: Gio.Cancellable,
	): Promise<result<boolean>> {
		const read = await read_drop_paths(drop, cancellable)
		if (!read.ok) return read

		const paths = read.value
		if (!paths.length) {
			console.error("desktop.drop: Drop contains no local files")
			return ok(false)
		}

		const state = active_drag.peek()
		const internal = paths.every(
			(path) => state.paths.includes(path) && !!monitor_of_desktop_path(path),
		)
		if (internal && action === DragAction.MOVE) {
			session.handled = true
			move(state.paths, state.anchor ?? paths[0], slot_at(x, y))
			return ok(true)
		}

		const imported = await import_files_to_desktop({
			paths,
			to: grid.peek().id,
			operation: action === DragAction.COPY ? "copy" : "move",
		})
		return ok(
			imported.failures.length === 0 && imported.created_paths.length > 0,
		)
	}

	async function complete_drop(
		drop: Gdk.Drop,
		action: Gdk.DragAction,
		x: number,
		y: number,
	) {
		const cancellable = new Gio.Cancellable()
		const deadline = timeout(30_000, () => cancellable.cancel())
		const completed = await place_drop(drop, action, x, y, cancellable)
		deadline.cancel()
		const placed =
			log_error(completed, "desktop.drop: Failed to complete drop") &&
			completed.value
		if (!placed) {
			drop.finish(0)
			return
		}
		set_drag_preview(null)
		drop.finish(action)
	}

	function note_hover(
		controller: Gtk.DropTargetAsync,
		drop: Gdk.Drop,
		x: number,
		y: number,
	): Gdk.DragAction {
		const state = active_drag.peek()
		const monitor_id = grid.peek().id
		if (state.paths.length > 0 && state.source && state.source !== monitor_id)
			session.hover = { monitor_id, x, y }
		return drop_action(drop, control_held(controller))
	}

	function track(x: number, y: number) {
		set_position({ x, y })
		set_hovered(true)
	}

	function leave() {
		if (session.hover?.monitor_id === grid.peek().id) session.hover = null
		set_hovered(false)
	}

	function attach_target(widget: Gtk.Fixed) {
		const target = Gtk.DropTargetAsync.new(
			Gdk.ContentFormats.new_for_gtype(Gdk.FileList.$gtype).union(
				Gdk.ContentFormats.new(["text/uri-list"]),
			),
			DragAction.MOVE | DragAction.COPY,
		)
		target.connect(
			"accept",
			(_controller, drop) =>
				drop.get_formats().contain_gtype(Gdk.FileList.$gtype) ||
				drop.get_formats().contain_mime_type("text/uri-list"),
		)

		target.connect("drag-enter", note_hover)
		target.connect("drag-motion", (controller, drop, x, y) => {
			const action = note_hover(controller, drop, x, y)
			track(x, y)
			return action
		})
		target.connect("drag-leave", leave)
		target.connect("drop", (controller, drop, x, y) => {
			const action = drop_action(drop, control_held(controller))
			if (!action) return false
			void complete_drop(drop, action, x, y)
			return true
		})
		widget.add_controller(target)
	}

	function register_target() {
		const monitor_id = grid.peek().id
		targets.set(monitor_id, (paths, anchor, x, y) => {
			session.handled = true
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
		track,
		leave,
	}
}

export function DragLayer({ drag }: { drag: desktop_drag_controller }) {
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
