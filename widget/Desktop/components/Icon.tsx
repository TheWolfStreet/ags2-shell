// Shows desktop icons, labels, selection, dragging, and inline renaming.

import { Accessor, createComputed, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import Pango from "gi://Pango"

import { desktopController } from "../DesktopController"
import type { DesktopIconMetrics } from "../model/GridGeometry"
import type { DesktopFile } from "../FileOperations"
import { createSquareTextureAccessor, hiddenDragIcon } from "$lib/textures"
import { updateLabelTooltip } from "$lib/ui"
import type { DesktopDragController } from "../interaction/DragAndDrop"
import { desktopInteraction, type DesktopGridModel } from "../model/DesktopState"
import { desktopContextMenu } from "./ContextMenu"

const { BUTTON_PRIMARY, BUTTON_SECONDARY, ModifierType } = Gdk
const { Justification } = Gtk
const { START, CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit
const { EllipsizeMode } = Pango

function isImageDesktopFile(file: DesktopFile): boolean {
	return file.contentType.startsWith("image/") || file.contentType === "image"
		|| file.icon.includes("image") || /\.(avif|bmp|gif|heic|heif|ico|jpe?g|jxl|png|svg|tiff?|webp)$/i.test(file.path)
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

function focusRename(entry: Gtk.Entry): void {
	entry.grab_focus()
	entry.select_region(0, renameSelectionEnd(entry.get_text()))
}

function IconGraphic({ size, preview, isCut, iconName }: {
	size: Accessor<number>
	preview: Accessor<Gdk.Paintable | null>
	isCut: Accessor<boolean>
	iconName: string
}) {
	const paintable = preview.as(image => image ?? hiddenDragIcon())
	return (
		<box class="desktop-icon-visual" widthRequest={size} heightRequest={size} halign={CENTER} valign={CENTER}>
			<image
				visible={preview.as(image => !image)}
				iconName={isCut.as(cut => cut ? "edit-cut" : iconName)}
				pixelSize={size}
				halign={CENTER}
				valign={CENTER}
				useFallback
			/>
			<Gtk.Picture
				class="desktop-icon-preview"
				visible={preview.as(image => !!image)}
				paintable={paintable}
				widthRequest={size}
				heightRequest={size}
				halign={CENTER}
				valign={CENTER}
				contentFit={COVER}
				canShrink
			/>
		</box>
	)
}

function IconLabel({ file, isInlineRename, labelChars, labelPillChars }: {
	file: DesktopFile
	isInlineRename: Accessor<boolean>
	labelChars: Accessor<number>
	labelPillChars: Accessor<number>
}) {
	let hadFocus = false
	return (
		<box class="desktop-icon-label" halign={CENTER} valign={START}>
			<label
				visible={isInlineRename.as(active => !active)}
				label={file.name}
				maxWidthChars={labelPillChars}
				widthChars={labelPillChars}
				ellipsize={EllipsizeMode.END}
				justify={Justification.CENTER}
				lines={1}
				halign={CENTER}
				onNotifyLabel={updateLabelTooltip}
				onNotifyVisible={updateLabelTooltip}
				onNotifyMaxWidthChars={updateLabelTooltip}
				$={updateLabelTooltip}
			/>
			<entry
				visible={isInlineRename}
				text={desktopInteraction.rename.value}
				xalign={0.5}
				widthChars={labelChars}
				maxWidthChars={labelChars}
				halign={CENTER}
				sensitive
				canFocus
				onNotifyText={self => desktopInteraction.rename.setValue(self.get_text())}
				onActivate={desktopInteraction.rename.commit}
				onNotifyVisible={self => { if (self.visible) focusRename(self) }}
				onNotifyHasFocus={self => {
					if (self.has_focus) {
						hadFocus = true
						return
					}
					if (hadFocus && desktopInteraction.rename.path.peek() === file.path) desktopInteraction.rename.commit()
				}}
				$={self => {
					if (desktopInteraction.rename.path.peek() === file.path) {
						idle(() => {
							if (desktopInteraction.rename.path.peek() === file.path && self.get_visible()) focusRename(self)
						})
					}
				}}
			/>
		</box>
	)
}

export function DesktopIcon({
	file,
	grid,
	drag,
	iconMetrics,
	selectedPaths,
	draggedPaths,
	cutPaths,
	registerWidget,
	unregisterWidget,
}: {
	file: DesktopFile
	grid: DesktopGridModel
	drag: DesktopDragController
	iconMetrics: Accessor<DesktopIconMetrics>
	selectedPaths: Accessor<Set<string>>
	draggedPaths: Accessor<Set<string>>
	cutPaths: Accessor<Set<string>>
	registerWidget(path: string, widget: Gtk.Widget): void
	unregisterWidget(path: string, widget: Gtk.Widget): void
}) {
	const isInlineRename = desktopInteraction.rename.path.as(path => path === file.path)
	const isCut = cutPaths.as(paths => paths.has(file.path))
	const supportsPreview = isImageDesktopFile(file)
	const previewPaintable = createComputed(() => {
		if (isCut() || !supportsPreview) return null
		return createSquareTextureAccessor(file.path, iconMetrics().iconPx)()
	})
	const iconPixelSize = iconMetrics.as(metrics => metrics.iconPx)
	const labelChars = iconMetrics.as(metrics => metrics.labelChars)
	const labelPillChars = iconMetrics.as(metrics => Math.max(4, metrics.labelChars - 1))
	const isSelected = selectedPaths.as(paths => paths.has(file.path))
	const isDragGroupMember = draggedPaths.as(paths => paths.size > 1 && paths.has(file.path))
	const cssClass = createComputed(() => {
		const selected = isSelected()
		const dragging = drag.state().paths.includes(file.path)
		const grouped = isDragGroupMember()
		return "desktop-icon"
			+ (selected ? " selected" : "")
			+ (dragging ? " dragging" : "")
			+ (grouped ? " drag-pack" : "")
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
				desktopInteraction.select(current.includes(file.path)
					? current.filter(path => path !== file.path)
					: [...current, file.path])
				return
			}
			if (current.length > 1 && current.includes(file.path)) {
				pendingSingleSelect = true
				return
			}
			desktopInteraction.select([file.path])
		}

		if (button === BUTTON_SECONDARY) {
			if (!desktopInteraction.selected.peek().includes(file.path)) desktopInteraction.select([file.path])
			const event = gesture.get_current_event()
			if (event) {
				const [success, x, y] = event.get_position()
				const shiftHeld = (gesture.get_current_event_state() & ModifierType.SHIFT_MASK) !== 0
				if (success) desktopContextMenu.show({ monitor: grid.monitor, monitorId: grid.id.peek(), x, y, shift: shiftHeld })
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
				drag.attachSource(self, file.path, () => { draggedSincePress = true })
				onCleanup(() => unregisterWidget(file.path, self))
			}}
		>
			<Gtk.GestureClick
				button={0}
				onPressed={(gesture, pressCount) => {
					if (desktopInteraction.rename.path.peek()) return
					const clickedButton = gesture.get_current_button()
					if (clickedButton === BUTTON_PRIMARY) {
						desktopInteraction.press(file.path)
						pendingSingleSelect = false
						draggedSincePress = false
					}
					handleClick(clickedButton, gesture)
					if (clickedButton === BUTTON_PRIMARY && pressCount === 2) desktopController.open([file.path])
				}}
				onReleased={gesture => {
					if (gesture.get_current_button() !== BUTTON_PRIMARY) return
					if (pendingSingleSelect && !draggedSincePress) desktopInteraction.select([file.path])
					pendingSingleSelect = false
					desktopInteraction.press(null)
				}}
			/>
			<box orientation={VERTICAL} hexpand vexpand halign={CENTER} valign={CENTER} class="desktop-icon-inner">
				<IconGraphic size={iconPixelSize} preview={previewPaintable} isCut={isCut} iconName={file.icon} />
				<IconLabel file={file} isInlineRename={isInlineRename} labelChars={labelChars} labelPillChars={labelPillChars} />
			</box>
		</box>
	)
}
