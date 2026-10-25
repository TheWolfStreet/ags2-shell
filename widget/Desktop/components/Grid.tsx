import { Accessor, createComputed, createState, For, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import GLib from "gi://GLib"

import { attempt_async, log_error } from "$lib/result"

import type { desktop_file } from "../file_operations"
import { DragLayer, type desktop_drag_controller } from "../DragAndDrop"
import {
	cancel_desktop_cut,
	copy_desktop_files,
	cut_desktop_files,
	desktop_clipboard,
	desktop_interaction,
	open_desktop_files,
	paste_desktop_files,
	remove_desktop_files,
	type desktop_grid_data,
} from "../desktop"
import {
	find_paths_intersecting_rectangle,
	get_desktop_icon_metrics,
	slot_index_to_rect,
	tab_order_target,
	type slot_rect,
} from "../grid_geometry"
import options, { ui_scale } from "$shell/options"
import { desktop_context_menu } from "./ContextMenu"
import { DesktopIcon } from "./Icon"

const {
	BUTTON_PRIMARY,
	BUTTON_SECONDARY,
	KEY_A,
	KEY_C,
	KEY_Delete,
	KEY_Escape,
	KEY_F2,
	KEY_ISO_Left_Tab,
	KEY_Return,
	KEY_Shift_L,
	KEY_Shift_R,
	KEY_Tab,
	KEY_V,
	KEY_X,
	KEY_a,
	KEY_c,
	KEY_v,
	KEY_x,
	ModifierType,
} = Gdk
const { FILL, START } = Gtk.Align
const empty_path_set = new Set<string>()

function is_interactive_target(widget: Gtk.Widget | null): boolean {
	let current = widget
	while (current) {
		if (current instanceof Gtk.Entry || current.has_css_class?.("desktop-icon"))
			return true
		current = current.get_parent()
	}
	return false
}

function hits_empty_desktop(
	gesture: Gtk.GestureClick,
	x: number,
	y: number,
): boolean {
	if (!options.desktop.enabled.peek()) return false
	const picked =
		gesture.get_widget()?.pick?.(x, y, Gtk.PickFlags.DEFAULT) ?? null
	return !is_interactive_target(picked)
}

function held(state: number, modifier: Gdk.ModifierType): boolean {
	return (state & modifier) !== 0
}

function is_shift_key(key: number): boolean {
	return key === KEY_Shift_L || key === KEY_Shift_R
}

async function run_logged(task: () => Promise<void>, tag: string) {
	log_error(await attempt_async(task), tag)
}

function control_key_pressed(grid: desktop_grid_data, key: number): boolean {
	const paths = desktop_interaction.selected.peek()
	if (key === KEY_a || key === KEY_A) {
		desktop_interaction.select(grid.files.map((file) => file.path))
		return true
	}
	if (key === KEY_c || key === KEY_C) {
		copy_desktop_files(paths)
		return true
	}
	if (key === KEY_x || key === KEY_X) {
		if (paths.length > 0) cut_desktop_files(paths)
		else
			void run_logged(
				cancel_desktop_cut,
				"desktop.keyboard: Failed to cancel cut",
			)
		return true
	}
	if (key === KEY_v || key === KEY_V) {
		void run_logged(
			() => paste_desktop_files(grid.id),
			"desktop.keyboard: Failed to paste files",
		)
		return true
	}
	return false
}

function plain_key_pressed(
	grid: desktop_grid_data,
	key: number,
	state: number,
): boolean {
	const paths = desktop_interaction.selected.peek()
	if (key === KEY_Escape) {
		desktop_context_menu.hide()
		return true
	}
	if (key === KEY_Delete) {
		const permanently = held(state, ModifierType.SHIFT_MASK)
		void run_logged(
			() => remove_desktop_files(paths, { permanently }),
			"desktop.keyboard: Failed to remove files",
		)
		return true
	}
	if (key === KEY_Tab || key === KEY_ISO_Left_Tab) {
		const backwards =
			key === KEY_ISO_Left_Tab || held(state, ModifierType.SHIFT_MASK)
		const target = tab_order_target(
			grid.files,
			grid.positions,
			paths,
			backwards,
		)
		if (target) desktop_interaction.select([target])
		return true
	}
	if (key === KEY_Return) {
		if (paths.length === 1) open_desktop_files(paths)
		return true
	}
	if (key === KEY_F2) {
		if (paths.length === 1) desktop_interaction.rename.begin(paths[0])
		return true
	}
	return false
}

function rename_key_pressed(key: number): boolean {
	if (key !== KEY_Escape) return false
	desktop_interaction.rename.cancel()
	return true
}

function key_pressed(
	grid: desktop_grid_data,
	key: number,
	state: number,
): boolean {
	if (is_shift_key(key)) {
		desktop_context_menu.set_shift_held(true)
		return false
	}
	if (!options.desktop.enabled.peek()) return false
	if (desktop_interaction.rename.path.peek()) return rename_key_pressed(key)
	if (held(state, ModifierType.CONTROL_MASK) && control_key_pressed(grid, key))
		return true
	return plain_key_pressed(grid, key, state)
}

export function attach_desktop_keyboard(
	window: Gtk.Window,
	grid: Accessor<desktop_grid_data>,
): void {
	const controller = new Gtk.EventControllerKey({
		propagation_phase: Gtk.PropagationPhase.CAPTURE,
	})
	controller.connect("key-pressed", (_self, key, _code, state) =>
		key_pressed(grid.peek(), key, state),
	)
	controller.connect("key-released", (_self, key) => {
		if (is_shift_key(key)) desktop_context_menu.set_shift_held(false)
	})
	window.add_controller(controller)
}

function root_point(
	widget: Gtk.Widget | null,
	x: number,
	y: number,
): [number, number] {
	const root = widget?.get_root()
	if (!widget || !(root instanceof Gtk.Widget)) return [x, y]
	const [translated, root_x, root_y] = widget.translate_coordinates(root, x, y)
	return translated ? [root_x, root_y] : [x, y]
}

function same_paths(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		left.every((path, index) => path === right[index])
	)
}

function normalize_rectangle(rectangle: slot_rect | null): slot_rect {
	if (!rectangle) return { x: 0, y: 0, width: 0, height: 0 }
	return {
		x: Math.min(rectangle.x, rectangle.x + rectangle.width),
		y: Math.min(rectangle.y, rectangle.y + rectangle.height),
		width: Math.abs(rectangle.width),
		height: Math.abs(rectangle.height),
	}
}

function DesktopInteractions({
	monitor,
	grid,
	drag,
}: {
	monitor: Gdk.Monitor
	grid: Accessor<desktop_grid_data>
	drag: desktop_drag_controller
}) {
	const [selection_rectangle, set_selection_rectangle] =
		createState<slot_rect | null>(null)
	const normalized_rectangle = selection_rectangle.as(normalize_rectangle)
	let last_selection_sample = 0

	function select_dragged(
		rectangle: slot_rect,
		width: number,
		height: number,
	): void {
		const data = grid.peek()
		if (!data.metrics) return
		const next = find_paths_intersecting_rectangle(
			data.files,
			data.positions,
			data.metrics,
			rectangle.x,
			rectangle.y,
			rectangle.x + width,
			rectangle.y + height,
		)
		if (!same_paths(desktop_interaction.selected.peek(), next))
			desktop_interaction.select(next)
	}

	function select_click(gesture: Gtk.GestureClick, x: number, y: number) {
		if (!hits_empty_desktop(gesture, x, y)) return
		if (desktop_interaction.rename.path.peek()) {
			desktop_interaction.rename.commit()
			return
		}
		desktop_interaction.select([])
		desktop_context_menu.hide()
	}

	function menu_click(gesture: Gtk.GestureClick, x: number, y: number) {
		if (!hits_empty_desktop(gesture, x, y)) return
		if (desktop_interaction.rename.path.peek())
			desktop_interaction.rename.commit()
		desktop_interaction.select([])
		const shift = held(
			gesture.get_current_event_state(),
			ModifierType.SHIFT_MASK,
		)
		const [menu_x, menu_y] = root_point(gesture.get_widget(), x, y)
		desktop_context_menu.show({
			monitor,
			monitor_id: grid.peek().id,
			x: menu_x,
			y: menu_y,
			shift,
		})
	}

	function begin_band(gesture: Gtk.GestureDrag, x: number, y: number) {
		if (!options.desktop.enabled.peek() || desktop_interaction.pressed.peek()) {
			gesture.reset()
			return
		}
		last_selection_sample = 0
		const rectangle = { x, y, width: 0, height: 0 }
		set_selection_rectangle(rectangle)
		desktop_context_menu.hide()
		select_dragged(rectangle, 0, 0)
	}

	function update_band(width: number, height: number) {
		const rectangle = selection_rectangle.peek()
		if (!rectangle) return
		set_selection_rectangle({ ...rectangle, width, height })
		const now = GLib.get_monotonic_time()
		if (now - last_selection_sample < 16_000) return
		last_selection_sample = now
		select_dragged(rectangle, width, height)
	}

	function end_band(width: number, height: number) {
		const rectangle = selection_rectangle.peek()
		if (rectangle && (Math.abs(width) > 5 || Math.abs(height) > 5))
			select_dragged(rectangle, width, height)
		set_selection_rectangle(null)
		desktop_interaction.redraw()
	}

	return (
		<>
			<Gtk.EventControllerMotion
				onEnter={desktop_context_menu.enter_desktop}
				onMotion={desktop_context_menu.enter_desktop}
				onLeave={desktop_context_menu.leave_desktop}
			/>
			<Gtk.DropControllerMotion
				onMotion={(_unused, x, y) => drag.track(x, y)}
				onLeave={drag.leave}
			/>
			<Gtk.GestureClick
				button={BUTTON_PRIMARY}
				onPressed={(gesture, _count, x, y) => select_click(gesture, x, y)}
			/>
			<Gtk.GestureClick
				button={BUTTON_SECONDARY}
				onPressed={(gesture, _count, x, y) => menu_click(gesture, x, y)}
			/>
			<Gtk.GestureDrag
				button={BUTTON_PRIMARY}
				onDragBegin={begin_band}
				onDragUpdate={(_gesture, width, height) => update_band(width, height)}
				onDragEnd={(_gesture, width, height) => end_band(width, height)}
			/>
			<box
				$type="overlay"
				visible={createComputed(
					() => options.desktop.enabled() && selection_rectangle() !== null,
				)}
				class="selection-rectangle"
				halign={START}
				valign={START}
				marginStart={normalized_rectangle.as((rectangle) => rectangle.x)}
				marginTop={normalized_rectangle.as((rectangle) => rectangle.y)}
				widthRequest={normalized_rectangle.as((rectangle) => rectangle.width)}
				heightRequest={normalized_rectangle.as((rectangle) => rectangle.height)}
			/>
		</>
	)
}

function file_identity(file: desktop_file): string {
	return `${file.path}\0${file.display_name ?? ""}\0${file.icon}\0${file.icon_file ?? ""}\0${file.content_type}\0${file.modified?.getTime() ?? 0}`
}

export function DesktopGrid({
	monitor,
	geometry,
	grid,
	drag,
}: {
	monitor: Gdk.Monitor
	geometry: Accessor<Gdk.Rectangle>
	grid: Accessor<desktop_grid_data>
	drag: desktop_drag_controller
}) {
	const widgets = new Map<string, Gtk.Widget>()
	let container: Gtk.Fixed | null = null
	const selected_paths = createComputed(() => {
		const selected = desktop_interaction.selected()
		return selected.length > 0 ? new Set(selected) : empty_path_set
	})
	const dragged_paths = createComputed(() => {
		const paths = drag.state().paths
		return paths.length > 0 ? new Set(paths) : empty_path_set
	})
	const cut_paths = createComputed(() => {
		const clipboard = desktop_clipboard()
		if (
			!clipboard ||
			clipboard.operation !== "cut" ||
			clipboard.paths.length === 0
		)
			return empty_path_set
		return new Set(clipboard.paths)
	})
	const icon_metrics = createComputed(() =>
		get_desktop_icon_metrics(options.desktop.iconSize(), ui_scale()),
	)
	const monitor_id = grid.as((data) => data.id)
	const content_height = createComputed(() => {
		const metrics = grid().metrics
		return metrics
			? metrics.offset_y +
					metrics.rows * metrics.cell_height +
					metrics.padding_bottom
			: geometry().height
	})
	const slot_rectangles = createComputed(() => {
		const data = grid()
		const rectangles: Record<string, slot_rect> = {}
		if (!data.metrics) return rectangles
		for (const file of data.files) {
			const slot_index = data.positions[file.path]
			if (slot_index != null)
				rectangles[file.path] = slot_index_to_rect(slot_index, data.metrics)
		}
		return rectangles
	})

	function place_icon(widget: Gtk.Widget, rectangle: slot_rect | undefined) {
		if (!container || !rectangle) return
		widget.set_size_request(rectangle.width, rectangle.height)
		container.move(widget, rectangle.x, rectangle.y)
	}

	function place_all_icons(): void {
		const rectangles = slot_rectangles.peek()
		for (const [path, widget] of widgets) place_icon(widget, rectangles[path])
	}

	function register_widget(path: string, widget: Gtk.Widget): void {
		widgets.set(path, widget)
		place_icon(widget, slot_rectangles.peek()[path])
	}

	function unregister_widget(path: string, widget: Gtk.Widget): void {
		if (widgets.get(path) === widget) widgets.delete(path)
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
				heightRequest={content_height}
			>
				<Gtk.Fixed
					visible={options.desktop.enabled}
					class="desktop-container"
					hexpand
					vexpand
					halign={FILL}
					valign={FILL}
					$={(fixed) => {
						container = fixed
						const unsubscribe = slot_rectangles.subscribe(place_all_icons)
						place_all_icons()
						drag.attach_target(fixed)
						onCleanup(() => {
							unsubscribe()
							container = null
						})
					}}
				>
					<For each={grid.as((data) => data.files)} id={file_identity}>
						{(file: desktop_file) => (
							<DesktopIcon
								file={file}
								monitor={monitor}
								monitor_id={monitor_id}
								drag={drag}
								icon_metrics={icon_metrics}
								selected_paths={selected_paths}
								dragged_paths={dragged_paths}
								cut_paths={cut_paths}
								register_widget={register_widget}
								unregister_widget={unregister_widget}
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
