import { Accessor, createComputed, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { idle } from "$lib/time"

import type { DesktopIconMetrics } from "../GridGeometry"
import type { DesktopFile } from "../FileOperations"
import { create_square_texture_accessor, hidden_drag_icon } from "$lib/textures"
import type { DesktopDragController } from "../DragAndDrop"
import { desktop_interaction, open_desktop_files } from "../Desktop"
import { desktop_context_menu } from "./ContextMenu"

const { BUTTON_PRIMARY, BUTTON_SECONDARY, ModifierType } = Gdk
const { START, CENTER, FILL } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit

function is_image_desktop_file(file: DesktopFile): boolean {
	return (
		file.contentType.startsWith("image/") ||
		file.contentType === "image" ||
		file.icon.includes("image") ||
		/\.(avif|bmp|gif|heic|heif|ico|jpe?g|jxl|png|svg|tiff?|webp)$/i.test(
			file.path,
		)
	)
}

function rename_selection_end(name: string): number {
	if (!name || name === "." || name === "..") return name.length
	if (name.startsWith(".")) {
		const next_dot = name.indexOf(".", 1)
		return next_dot > 1 ? next_dot : name.length
	}
	const extension = name.indexOf(".")
	return extension > 0 ? extension : name.length
}

function ensure_rename_focus(editor: Gtk.Text, file: DesktopFile): void {
	if (
		editor.editable &&
		desktop_interaction.rename.path.peek() === file.path
	)
		focus_rename(editor)
}

function focus_rename(editor: Gtk.Text): void {
	editor.grab_focus()
	idle(() => {
		if (
			!editor.editable ||
			!editor.has_focus ||
			!desktop_interaction.rename.path.peek()
		)
			return
		const name = desktop_interaction.rename.value.peek()
		if (editor.get_text() !== name) editor.set_text(name)
		editor.select_region(0, rename_selection_end(name))
	})
}

function IconGraphic({
	size,
	preview,
	is_cut: is_cut,
	icon_name: icon_name,
	is_launcher: is_launcher,
}: {
	size: Accessor<number>
	preview: Accessor<Gdk.Paintable | null>
	is_cut: Accessor<boolean>
	icon_name: string
	is_launcher: boolean
}) {
	const paintable = preview.as((image) => image ?? hidden_drag_icon())
	const emblem_size = size.as((value) => Math.max(10, Math.round(value * 0.22)))
	return (
		<overlay
			class="desktop-icon-visual"
			widthRequest={size}
			heightRequest={size}
			halign={CENTER}
			valign={CENTER}
		>
			<box
				widthRequest={size}
				heightRequest={size}
				halign={CENTER}
				valign={CENTER}
			>
				<image
					visible={preview.as((image) => !image)}
					iconName={is_cut.as((cut) => (cut ? "edit-cut" : icon_name))}
					pixelSize={size}
					halign={CENTER}
					valign={CENTER}
					useFallback
				/>
				<Gtk.Picture
					class="desktop-icon-preview"
					visible={preview.as((image) => !!image)}
					paintable={paintable}
					widthRequest={size}
					heightRequest={size}
					halign={CENTER}
					valign={CENTER}
					contentFit={COVER}
					canShrink
				/>
			</box>
			<image
				$type="overlay"
				class="desktop-shortcut-emblem"
				visible={is_cut.as((cut) => is_launcher && !cut)}
				iconName="emblem-symbolic-link-symbolic"
				pixelSize={emblem_size}
				halign={START}
				valign={Gtk.Align.END}
			/>
		</overlay>
	)
}

function IconLabel({
	file,
	is_inline_rename: is_inline_rename,
	label_pill_chars: label_pill_chars,
}: {
	file: DesktopFile
	is_inline_rename: Accessor<boolean>
	label_pill_chars: Accessor<number>
}) {
	const display_name = file.displayName ?? file.name
	const text = createComputed(() => {
		if (is_inline_rename()) return desktop_interaction.rename.value()
		const characters = [...display_name]
		const max_characters = label_pill_chars()
		return characters.length > max_characters
			? `${characters.slice(0, Math.max(1, max_characters - 1)).join("")}…`
			: display_name
	})
	const tooltip = label_pill_chars.as((max_characters) =>
		[...display_name].length > max_characters ? display_name : "",
	)
	return (
		<box
			class="desktop-icon-label"
			tooltipText={tooltip}
			halign={CENTER}
			valign={START}
			overflow={Gtk.Overflow.HIDDEN}
		>
			<Gtk.Text
				class="desktop-icon-rename"
				text={text}
				xalign={0.5}
				maxWidthChars={label_pill_chars}
				widthChars={label_pill_chars}
				propagateTextWidth={false}
				halign={FILL}
				editable={is_inline_rename}
				canFocus={is_inline_rename}
				canTarget={is_inline_rename}
				onNotifyText={(self) => {
					if (is_inline_rename.peek())
						desktop_interaction.rename.set_value(self.get_text())
				}}
				onActivate={desktop_interaction.rename.commit}
				onNotifyEditable={(self) => {
					if (self.editable) {
						idle(() => ensure_rename_focus(self, file))
						return
					}
					self.select_region(0, 0)
					const root = self.get_root()
					if (root instanceof Gtk.Window && root.get_focus() === self)
						root.set_focus(null)
				}}
				onNotifyHasFocus={(self) => {
					if (
						self.has_focus ||
						desktop_interaction.rename.path.peek() !== file.path
					)
						return
					idle(() => {
						const root = self.get_root()
						if (
							self.get_mapped() &&
							root instanceof Gtk.Window &&
							root.is_active
						)
							ensure_rename_focus(self, file)
					})
				}}
				$={(self) => {
					self.connect("map", () => ensure_rename_focus(self, file))
				}}
			/>
		</box>
	)
}

export function DesktopIcon({
	file,
	monitor,
	monitorId: monitor_id,
	drag,
	iconMetrics: icon_metrics,
	selectedPaths: selected_paths,
	draggedPaths: dragged_paths,
	cutPaths: cut_paths,
	register_widget,
	unregister_widget,
}: {
	file: DesktopFile
	monitor: Gdk.Monitor
	monitorId: Accessor<string>
	drag: DesktopDragController
	iconMetrics: Accessor<DesktopIconMetrics>
	selectedPaths: Accessor<Set<string>>
	draggedPaths: Accessor<Set<string>>
	cutPaths: Accessor<Set<string>>
	register_widget(path: string, widget: Gtk.Widget): void
	unregister_widget(path: string, widget: Gtk.Widget): void
}) {
	const is_inline_rename = desktop_interaction.rename.path.as(
		(path) => path === file.path,
	)
	const is_cut = cut_paths.as((paths) => paths.has(file.path))
	const is_launcher = file.path.toLowerCase().endsWith(".desktop")
	const supports_preview = is_image_desktop_file(file) || !!file.iconFile
	const preview_texture = createComputed(() => {
		if (is_cut() || !supports_preview) return null
		return create_square_texture_accessor(
			file.iconFile ?? file.path,
			icon_metrics().iconPx,
		)
	})
	const preview_paintable = createComputed(() => preview_texture()?.() ?? null)
	const icon_pixel_size = icon_metrics.as((metrics) => metrics.iconPx)
	const label_pill_chars = icon_metrics.as((metrics) =>
		Math.max(4, metrics.labelChars - 1),
	)
	const is_selected = selected_paths.as((paths) => paths.has(file.path))
	const is_drag_group_member = dragged_paths.as(
		(paths) => paths.size > 1 && paths.has(file.path),
	)
	const css_class = createComputed(() => {
		const selected = is_selected()
		const dragging = drag.state().paths.includes(file.path)
		const grouped = is_drag_group_member()
		return (
			"desktop-icon" +
			(selected ? " selected" : "") +
			(dragging ? " dragging" : "") +
			(grouped ? " drag-pack" : "")
		)
	})
	let pending_single_select = false
	let dragged_since_press = false

	function handle_click(button: number, gesture: Gtk.GestureClick): void {
		if (button === BUTTON_PRIMARY) {
			desktop_context_menu.hide()
			const state = gesture.get_current_event_state()
			const control_held = (state & ModifierType.CONTROL_MASK) !== 0
			const current = desktop_interaction.selected.peek()
			if (control_held) {
				desktop_interaction.select(
					current.includes(file.path)
						? current.filter((path) => path !== file.path)
						: [...current, file.path],
				)
				return
			}
			if (current.length > 1 && current.includes(file.path)) {
				pending_single_select = true
				return
			}
			desktop_interaction.select([file.path])
		}

		if (button === BUTTON_SECONDARY) {
			if (!desktop_interaction.selected.peek().includes(file.path))
				desktop_interaction.select([file.path])
			const event = gesture.get_current_event()
			if (event) {
				const [success, x, y] = event.get_position()
				const shift_held =
					(gesture.get_current_event_state() & ModifierType.SHIFT_MASK) !== 0
				if (success)
					desktop_context_menu.show({
						monitor,
						monitor_id: monitor_id.peek(),
						x,
						y,
						shift: shift_held,
					})
			}
		}
	}

	return (
		<box
			class={css_class}
			halign={START}
			valign={START}
			$={(self: Gtk.Widget) => {
				register_widget(file.path, self)
				drag.attach_source(self, file.path, () => {
					dragged_since_press = true
				})
				onCleanup(() => unregister_widget(file.path, self))
			}}
		>
			<Gtk.GestureClick
				button={0}
				onPressed={(gesture, press_count) => {
					const renamed_path = desktop_interaction.rename.path.peek()
					if (renamed_path === file.path) return
					if (renamed_path) desktop_interaction.rename.commit()
					const clicked_button = gesture.get_current_button()
					if (clicked_button === BUTTON_PRIMARY) {
						desktop_interaction.press(file.path)
						pending_single_select = false
						dragged_since_press = false
					}
					handle_click(clicked_button, gesture)
					if (clicked_button === BUTTON_PRIMARY && press_count === 2)
						open_desktop_files([file.path])
				}}
				onReleased={(gesture) => {
					if (gesture.get_current_button() !== BUTTON_PRIMARY) return
					if (pending_single_select && !dragged_since_press)
						desktop_interaction.select([file.path])
					pending_single_select = false
					desktop_interaction.press(null)
				}}
			/>
			<box
				orientation={VERTICAL}
				hexpand
				vexpand
				halign={CENTER}
				valign={CENTER}
				class="desktop-icon-inner"
			>
				<IconGraphic
					size={icon_pixel_size}
					preview={preview_paintable}
					is_cut={is_cut}
					icon_name={file.icon}
					is_launcher={is_launcher}
				/>
				<IconLabel
					file={file}
					is_inline_rename={is_inline_rename}
					label_pill_chars={label_pill_chars}
				/>
			</box>
		</box>
	)
}
