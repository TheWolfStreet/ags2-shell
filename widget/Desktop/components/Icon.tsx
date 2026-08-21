// Shows desktop icons, labels, selection, dragging, and inline renaming.

import { Accessor, createComputed, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import type { DesktopIconMetrics } from "../GridGeometry"
import type { DesktopFile } from "../FileOperations"
import { createSquareTextureAccessor, hiddenDragIcon } from "$lib/textures"
import type { DesktopDragController } from "../DragAndDrop"
import { desktopInteraction, openDesktopFiles } from "../Desktop"
import { desktopContextMenu } from "./ContextMenu"

const { BUTTON_PRIMARY, BUTTON_SECONDARY, ModifierType } = Gdk
const { START, CENTER, FILL } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit

function isImageDesktopFile(file: DesktopFile): boolean {
	return (
		file.contentType.startsWith("image/") ||
		file.contentType === "image" ||
		file.icon.includes("image") ||
		/\.(avif|bmp|gif|heic|heif|ico|jpe?g|jxl|png|svg|tiff?|webp)$/i.test(
			file.path,
		)
	)
}

function renameSelectionEnd(name: string): number {
	if (!name || name === "." || name === "..") return name.length
	if (name.startsWith(".")) {
		const nextDot = name.indexOf(".", 1)
		return nextDot > 1 ? nextDot : name.length
	}
	const extension = name.indexOf(".")
	return extension > 0 ? extension : name.length
}

function focusRename(editor: Gtk.Text): void {
	editor.grab_focus()
	idle(() => {
		if (
			!editor.editable ||
			!editor.has_focus ||
			!desktopInteraction.rename.path.peek()
		)
			return
		const name = desktopInteraction.rename.value.peek()
		if (editor.get_text() !== name) editor.set_text(name)
		editor.select_region(0, renameSelectionEnd(name))
	})
}

function IconGraphic({
	size,
	preview,
	isCut,
	iconName,
	isLauncher,
}: {
	size: Accessor<number>
	preview: Accessor<Gdk.Paintable | null>
	isCut: Accessor<boolean>
	iconName: string
	isLauncher: boolean
}) {
	const paintable = preview.as((image) => image ?? hiddenDragIcon())
	const emblemSize = size.as((value) => Math.max(10, Math.round(value * 0.22)))
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
					iconName={isCut.as((cut) => (cut ? "edit-cut" : iconName))}
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
				visible={isCut.as((cut) => isLauncher && !cut)}
				iconName="emblem-symbolic-link-symbolic"
				pixelSize={emblemSize}
				halign={START}
				valign={Gtk.Align.END}
			/>
		</overlay>
	)
}

function IconLabel({
	file,
	isInlineRename,
	labelPillChars,
}: {
	file: DesktopFile
	isInlineRename: Accessor<boolean>
	labelPillChars: Accessor<number>
}) {
	const displayName = file.displayName ?? file.name
	const text = createComputed(() => {
		if (isInlineRename()) return desktopInteraction.rename.value()
		const characters = [...displayName]
		const maxCharacters = labelPillChars()
		return characters.length > maxCharacters
			? `${characters.slice(0, Math.max(1, maxCharacters - 1)).join("")}…`
			: displayName
	})
	const tooltip = labelPillChars.as((maxCharacters) =>
		[...displayName].length > maxCharacters ? displayName : "",
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
				maxWidthChars={labelPillChars}
				widthChars={labelPillChars}
				propagateTextWidth={false}
				halign={FILL}
				editable={isInlineRename}
				canFocus={isInlineRename}
				canTarget={isInlineRename}
				onNotifyText={(self) => {
					if (isInlineRename.peek())
						desktopInteraction.rename.setValue(self.get_text())
				}}
				onActivate={desktopInteraction.rename.commit}
				onNotifyEditable={(self) => {
					if (self.editable) {
						idle(() => {
							if (
								self.editable &&
								desktopInteraction.rename.path.peek() === file.path
							)
								focusRename(self)
						})
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
						desktopInteraction.rename.path.peek() !== file.path
					)
						return
					idle(() => {
						const root = self.get_root()
						if (
							self.get_mapped() &&
							self.editable &&
							root instanceof Gtk.Window &&
							root.is_active &&
							desktopInteraction.rename.path.peek() === file.path
						)
							focusRename(self)
					})
				}}
				$={(self) => {
					self.connect("map", () => {
						if (
							self.editable &&
							desktopInteraction.rename.path.peek() === file.path
						)
							focusRename(self)
					})
				}}
			/>
		</box>
	)
}

export function DesktopIcon({
	file,
	monitor,
	monitorId,
	drag,
	iconMetrics,
	selectedPaths,
	draggedPaths,
	cutPaths,
	registerWidget,
	unregisterWidget,
}: {
	file: DesktopFile
	monitor: Gdk.Monitor
	monitorId: Accessor<string>
	drag: DesktopDragController
	iconMetrics: Accessor<DesktopIconMetrics>
	selectedPaths: Accessor<Set<string>>
	draggedPaths: Accessor<Set<string>>
	cutPaths: Accessor<Set<string>>
	registerWidget(path: string, widget: Gtk.Widget): void
	unregisterWidget(path: string, widget: Gtk.Widget): void
}) {
	const isInlineRename = desktopInteraction.rename.path.as(
		(path) => path === file.path,
	)
	const isCut = cutPaths.as((paths) => paths.has(file.path))
	const isLauncher = file.path.toLowerCase().endsWith(".desktop")
	const supportsPreview = isImageDesktopFile(file) || !!file.iconFile
	const previewPaintable = createComputed(() => {
		if (isCut() || !supportsPreview) return null
		return createSquareTextureAccessor(
			file.iconFile ?? file.path,
			iconMetrics().iconPx,
		)()
	})
	const iconPixelSize = iconMetrics.as((metrics) => metrics.iconPx)
	const labelPillChars = iconMetrics.as((metrics) =>
		Math.max(4, metrics.labelChars - 1),
	)
	const isSelected = selectedPaths.as((paths) => paths.has(file.path))
	const isDragGroupMember = draggedPaths.as(
		(paths) => paths.size > 1 && paths.has(file.path),
	)
	const cssClass = createComputed(() => {
		const selected = isSelected()
		const dragging = drag.state().paths.includes(file.path)
		const grouped = isDragGroupMember()
		return (
			"desktop-icon" +
			(selected ? " selected" : "") +
			(dragging ? " dragging" : "") +
			(grouped ? " drag-pack" : "")
		)
	})
	let pendingSingleSelect = false
	let draggedSincePress = false

	function handleClick(button: number, gesture: Gtk.GestureClick): void {
		if (button === BUTTON_PRIMARY) {
			desktopContextMenu.hide()
			const state = gesture.get_current_event_state()
			const controlHeld = (state & ModifierType.CONTROL_MASK) !== 0
			const current = desktopInteraction.selected.peek()
			if (controlHeld) {
				desktopInteraction.select(
					current.includes(file.path)
						? current.filter((path) => path !== file.path)
						: [...current, file.path],
				)
				return
			}
			if (current.length > 1 && current.includes(file.path)) {
				pendingSingleSelect = true
				return
			}
			desktopInteraction.select([file.path])
		}

		if (button === BUTTON_SECONDARY) {
			if (!desktopInteraction.selected.peek().includes(file.path))
				desktopInteraction.select([file.path])
			const event = gesture.get_current_event()
			if (event) {
				const [success, x, y] = event.get_position()
				const shiftHeld =
					(gesture.get_current_event_state() & ModifierType.SHIFT_MASK) !== 0
				if (success)
					desktopContextMenu.show({
						monitor,
						monitorId: monitorId.peek(),
						x,
						y,
						shift: shiftHeld,
					})
			}
		}
	}

	return (
		<box
			class={cssClass}
			halign={START}
			valign={START}
			$={(self: Gtk.Widget) => {
				registerWidget(file.path, self)
				drag.attachSource(self, file.path, () => {
					draggedSincePress = true
				})
				onCleanup(() => unregisterWidget(file.path, self))
			}}
		>
			<Gtk.GestureClick
				button={0}
				onPressed={(gesture, pressCount) => {
					const renamedPath = desktopInteraction.rename.path.peek()
					if (renamedPath === file.path) return
					if (renamedPath) desktopInteraction.rename.commit()
					const clickedButton = gesture.get_current_button()
					if (clickedButton === BUTTON_PRIMARY) {
						desktopInteraction.press(file.path)
						pendingSingleSelect = false
						draggedSincePress = false
					}
					handleClick(clickedButton, gesture)
					if (clickedButton === BUTTON_PRIMARY && pressCount === 2)
						openDesktopFiles([file.path])
				}}
				onReleased={(gesture) => {
					if (gesture.get_current_button() !== BUTTON_PRIMARY) return
					if (pendingSingleSelect && !draggedSincePress)
						desktopInteraction.select([file.path])
					pendingSingleSelect = false
					desktopInteraction.press(null)
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
					size={iconPixelSize}
					preview={previewPaintable}
					isCut={isCut}
					iconName={file.icon}
					isLauncher={isLauncher}
				/>
				<IconLabel
					file={file}
					isInlineRename={isInlineRename}
					labelPillChars={labelPillChars}
				/>
			</box>
		</box>
	)
}
