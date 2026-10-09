import { Accessor, createComputed, createState, For, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import GLib from "gi://GLib"

import type { DesktopFile } from "../FileOperations"
import { DragLayer, type DesktopDragController } from "../DragAndDrop"
import {
	cancel_desktop_cut,
	copy_desktop_files,
	cut_desktop_files,
	desktop_clipboard,
	desktop_interaction,
	open_desktop_files,
	paste_desktop_files,
	remove_desktop_files,
	type DesktopGridData,
} from "../Desktop"
import {
	find_paths_intersecting_rectangle,
	get_desktop_icon_metrics,
	slot_index_to_rect,
	type SlotRect,
} from "../GridGeometry"
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
	KEY_Return,
	KEY_Shift_L,
	KEY_Shift_R,
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
const no_layout: (path: string, widget: Gtk.Widget) => void = () => {}

type selection_rectangle = {
	x: number
	y: number
	width: number
	height: number
}

function is_interactive_target(widget: Gtk.Widget | null): boolean {
	let current = widget
	while (current) {
		if (current instanceof Gtk.Entry || current.has_css_class?.("desktop-icon"))
			return true
		current = current.get_parent()
	}
	return false
}

function hit_interactive_target(
	gesture: Gtk.GestureClick,
	x: number,
	y: number,
): boolean {
	const picked =
		gesture.get_widget()?.pick?.(x, y, Gtk.PickFlags.DEFAULT) ?? null
	return is_interactive_target(picked)
}

function key_pressed(
	grid: DesktopGridData,
	key: number,
	state: number,
): boolean {
	if (key === KEY_Shift_L || key === KEY_Shift_R) {
		desktop_context_menu.set_shift_held(true)
		return false
	}
	if (!options.desktop.enabled.peek()) return false
	if (desktop_interaction.rename.path.peek()) {
		if (key === KEY_Escape) {
			desktop_interaction.rename.cancel()
			return true
		}
		return false
	}

	const paths = desktop_interaction.selected.peek()
	const control = (state & ModifierType.CONTROL_MASK) !== 0
	if (key === KEY_Escape) {
		desktop_context_menu.hide()
		return true
	}
	if (key === KEY_Delete) {
		void remove_desktop_files(paths, {
			permanently: (state & ModifierType.SHIFT_MASK) !== 0,
		}).catch((error) =>
			console.error("desktop.keyboard: Failed to remove files", error),
		)
		return true
	}
	if (control && (key === KEY_a || key === KEY_A)) {
		desktop_interaction.select(grid.files.map((file) => file.path))
		return true
	}
	if (control && (key === KEY_c || key === KEY_C)) {
		copy_desktop_files(paths)
		return true
	}
	if (control && (key === KEY_x || key === KEY_X)) {
		if (paths.length > 0) cut_desktop_files(paths)
		else
			void cancel_desktop_cut().catch((error) =>
				console.error("desktop.keyboard: Failed to cancel cut", error),
			)
		return true
	}
	if (control && (key === KEY_v || key === KEY_V)) {
		void paste_desktop_files(grid.id).catch((error) =>
			console.error("desktop.keyboard: Failed to paste files", error),
		)
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

export function attach_desktop_keyboard(
	window: Gtk.Window,
	grid: Accessor<DesktopGridData>,
): void {
	const controller = new Gtk.EventControllerKey()
	controller.connect("key-pressed", (_self, key, _code, state) =>
		key_pressed(grid.peek(), key, state),
	)
	controller.connect("key-released", (_self, key) => {
		if (key === KEY_Shift_L || key === KEY_Shift_R)
			desktop_context_menu.set_shift_held(false)
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
	const [selecting, set_selecting] = createState(false)
	const [selection_rectangle, set_selection_rectangle] =
		createState<selection_rectangle | null>(null)
	const normalized_rectangle = createComputed(() => {
		const rectangle = selection_rectangle()
		if (!rectangle) return { x: 0, y: 0, width: 0, height: 0 }
		return {
			x: Math.min(rectangle.x, rectangle.x + rectangle.width),
			y: Math.min(rectangle.y, rectangle.y + rectangle.height),
			width: Math.abs(rectangle.width),
			height: Math.abs(rectangle.height),
		}
	})
	let last_selection_sample = 0

	function select_rectangle(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
	): void {
		const data = grid.peek()
		if (!data.metrics) return
		const next = find_paths_intersecting_rectangle(
			data.files,
			data.positions,
			data.metrics,
			x1,
			y1,
			x2,
			y2,
		)
		const current = desktop_interaction.selected.peek()
		if (
			current.length !== next.length ||
			current.some((path, index) => path !== next[index])
		)
			desktop_interaction.select(next)
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
				onPressed={(gesture, _count, x, y) => {
					if (
						!options.desktop.enabled.peek() ||
						hit_interactive_target(gesture, x, y)
					)
						return
					if (desktop_interaction.rename.path.peek()) {
						desktop_interaction.rename.commit()
						return
					}
					desktop_interaction.select([])
					desktop_context_menu.hide()
				}}
			/>
			<Gtk.GestureClick
				button={BUTTON_SECONDARY}
				onPressed={(gesture, _count, x, y) => {
					if (
						!options.desktop.enabled.peek() ||
						hit_interactive_target(gesture, x, y)
					)
						return
					if (desktop_interaction.rename.path.peek())
						desktop_interaction.rename.commit()
					desktop_interaction.select([])
					const shift =
						(gesture.get_current_event_state() & ModifierType.SHIFT_MASK) !== 0
					const widget = gesture.get_widget()
					const root = widget?.get_root()
					let translated = false
					let menu_x = x
					let menu_y = y
					if (widget && root instanceof Gtk.Widget)
						[translated, menu_x, menu_y] = widget.translate_coordinates(
							root,
							x,
							y,
						)
					desktop_context_menu.show({
						monitor,
						monitor_id: grid.peek().id,
						x: translated ? menu_x : x,
						y: translated ? menu_y : y,
						shift,
					})
				}}
			/>
			<Gtk.GestureDrag
				button={BUTTON_PRIMARY}
				onDragBegin={(gesture, x, y) => {
					if (
						!options.desktop.enabled.peek() ||
						desktop_interaction.pressed.peek()
					) {
						gesture.reset()
						return
					}
					last_selection_sample = 0
					set_selecting(true)
					set_selection_rectangle({ x, y, width: 0, height: 0 })
					desktop_context_menu.hide()
					select_rectangle(x, y, x, y)
				}}
				onDragUpdate={(_gesture, width, height) => {
					const rectangle = selection_rectangle.peek()
					if (!rectangle) return
					set_selection_rectangle({ ...rectangle, width, height })
					const now = GLib.get_monotonic_time()
					if (now - last_selection_sample >= 16_000) {
						last_selection_sample = now
						select_rectangle(
							rectangle.x,
							rectangle.y,
							rectangle.x + width,
							rectangle.y + height,
						)
					}
				}}
				onDragEnd={(_gesture, width, height) => {
					set_selecting(false)
					const rectangle = selection_rectangle.peek()
					if (rectangle && (Math.abs(width) > 5 || Math.abs(height) > 5))
						select_rectangle(
							rectangle.x,
							rectangle.y,
							rectangle.x + width,
							rectangle.y + height,
						)
					set_selection_rectangle(null)
					desktop_interaction.redraw()
				}}
			/>
			<box
				$type="overlay"
				visible={createComputed(() => options.desktop.enabled() && selecting())}
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
	let layout_icon = no_layout
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
			clipboard.files.length === 0
		)
			return empty_path_set
		return new Set(clipboard.files)
	})
	const icon_metrics = createComputed(() =>
		get_desktop_icon_metrics(options.desktop.iconSize(), ui_scale()),
	)
	const monitor_id = grid.as((data) => data.id)
	const content_height = createComputed(() => {
		const metrics = grid().metrics
		return metrics
			? metrics.offsetY +
					metrics.rows * metrics.cellHeight +
					metrics.paddingBottom
			: geometry().height
	})
	const slot_rectangles = createComputed(() => {
		const data = grid()
		const rectangles: Record<string, SlotRect> = {}
		if (!data.metrics) return rectangles
		for (const file of data.files) {
			const slot_index = data.positions[file.path]
			if (slot_index != null)
				rectangles[file.path] = slot_index_to_rect(slot_index, data.metrics)
		}
		return rectangles
	})

	function register_widget(path: string, widget: Gtk.Widget): void {
		widgets.set(path, widget)
		layout_icon(path, widget)
	}

	function unregister_widget(path: string, widget: Gtk.Widget): void {
		if (widgets.get(path) === widget) widgets.delete(path)
	}

	function bind_layout(fixed: Gtk.Fixed): () => void {
		function place_icon(widget: Gtk.Widget, rectangle: SlotRect): void {
			widget.set_size_request(rectangle.width, rectangle.height)
			fixed.move(widget, rectangle.x, rectangle.y)
		}

		function apply_all_layouts(): void {
			const rectangles = slot_rectangles.peek()
			for (const [path, widget] of widgets) {
				const rectangle = rectangles[path]
				if (rectangle) place_icon(widget, rectangle)
			}
		}

		layout_icon = (path, widget) => {
			const rectangle = slot_rectangles.peek()[path]
			if (rectangle) place_icon(widget, rectangle)
		}
		const unsubscribe = slot_rectangles.subscribe(apply_all_layouts)
		apply_all_layouts()
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
						const unbind_layout = bind_layout(fixed)
						drag.attach_target(fixed)
						onCleanup(() => {
							unbind_layout()
							layout_icon = no_layout
						})
					}}
				>
					<For
						each={grid.as((data) => data.files)}
						id={(file) =>
							`${file.path}\0${file.displayName ?? ""}\0${file.icon}\0${file.iconFile ?? ""}\0${file.contentType}\0${file.modified?.getTime() ?? 0}`
						}
					>
						{(file: DesktopFile) => (
							<DesktopIcon
								file={file}
								monitor={monitor}
								monitorId={monitor_id}
								drag={drag}
								iconMetrics={icon_metrics}
								selectedPaths={selected_paths}
								draggedPaths={dragged_paths}
								cutPaths={cut_paths}
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
