import app from "ags/gtk4/app"
import { Accessor, createBinding, createComputed, createState, For, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import Pango from "gi://Pango"

import { desktop, hypr } from "$lib/services"
import { hiddenDragIcon, textureFromUriSquareContainAsync } from "$lib/textures"
import { isInsideEntry, updateLabelTooltip } from "$lib/utils"
import {
	getGridMetrics,
	pointToSlotIndex,
	selectPathsByRectangle,
	slotIndexToRect,
} from "$service/Desktop/layout"
import type {
	DesktopIconMetrics,
	GridMetrics,
	SlotRect,
} from "$service/Desktop/layout"
import type { DesktopFile } from "$service/Desktop/files"
import type { DesktopDrag } from "./Drag"
import { DragLayer } from "./Drag"
import { menu } from "./Menu"
import { session } from "./session"

import options from "options"

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
const { Justification } = Gtk
const { START, FILL, CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit
const { EllipsizeMode } = Pango

export type GridModel = {
	monitor: Gdk.Monitor
	id: Accessor<string>
	geometry: Accessor<Gdk.Rectangle>
	metrics: Accessor<GridMetrics>
	files: Accessor<DesktopFile[]>
	positions: Accessor<Record<string, number>>
	slotAt(x: number, y: number): number
	move(paths: string[], anchor: string, slot: number): void
	import(paths: string[], operation: "copy" | "move"): void
	paste(): void
	createFolder(): string | null
}

function fontSize(font: string) {
	const match = font.trim().match(/(\d+(?:\.\d+)?)\s*$/)
	if (!match)
		return 11
	const size = Number.parseFloat(match[1])
	return Number.isFinite(size) && size > 0 ? size : 11
}

function connectorName(monitor: Gdk.Monitor) {
	const getConnector = Reflect.get(monitor, "get_connector")
	if (typeof getConnector !== "function")
		return ""
	const connector = getConnector.call(monitor)
	return typeof connector === "string" ? connector.toLowerCase() : ""
}

function matchMonitor(monitor: Gdk.Monitor, monitors: AstalHyprland.Monitor[]) {
	const geometry = monitor.get_geometry()
	const connector = connectorName(monitor)
	const match = monitors.find(item => item.name?.toLowerCase?.() === connector)
		?? monitors.find(item => item.x === geometry.x
			&& item.y === geometry.y
			&& item.width === geometry.width
			&& item.height === geometry.height)
	return { connector, geometry, match }
}

function monitorKey(monitor: Gdk.Monitor, monitors: AstalHyprland.Monitor[]) {
	const { connector, geometry, match } = matchMonitor(monitor, monitors)
	if (match?.name)
		return `monitor:${match.name.toLowerCase()}`
	if (connector)
		return `monitor:${connector}`
	return `monitor:${geometry.x}:${geometry.y}:${geometry.width}x${geometry.height}`
}

function desktopPadding() {
	const g = Math.max(0.1, options.scale() / 100)
	const padding = Math.max(0, Math.floor(options.theme.padding() * g))
	const font = Math.max(8, Math.floor(fontSize(options.font()) * g))
	const bar = Math.max(24, Math.round(font + (padding * 1.6) + 10 * g))
	let top = 0
	let bottom = 0
	let left = 0

	if (options.bar.position() === "bottom-center")
		bottom += bar
	else
		top += bar

	if (options.taskbar.location() === "dock" && options.dock.mode() === "static") {
		const scale = Math.max(0.25, options.dock.scale() / 100) * g
		const dock = Math.max(48, Math.round((64 + 4 * 2 + 4 + 4 + 6 * 2 + 2 * 2) * scale) + Math.max(0, Math.floor(options.theme.spacing() * g)))
		if (options.dock.position() === "center-left")
			left += dock
		else if (options.dock.position() === "bottom-center")
			bottom += dock
	}

	return { top, right: 0, bottom, left }
}

function monitorId(monitor: Gdk.Monitor) {
	const monitors = createBinding(hypr, "monitors")
	const geometry = createBinding(monitor, "geometry")
	return createComputed(() => {
		geometry()
		return monitorKey(monitor, monitors() ?? [])
	})
}

export function createGrid(monitor: Gdk.Monitor): GridModel {
	const appMonitors = createBinding(app, "monitors")
	const hyprMonitors = createBinding(hypr, "monitors")
	const geometry = createBinding(monitor, "geometry")
	const id = monitorId(monitor)
	const padding = createComputed(desktopPadding)
	const metrics = createComputed(() => {
		const { geometry } = matchMonitor(monitor, hyprMonitors() ?? [])
		return getGridMetrics(geometry.width, geometry.height, padding(), session.iconMetrics().cellPx)
	})
	const files = createComputed(() => desktop.grid(id()).files())
	const positions = createComputed(() => desktop.grid(id()).positions())

	function reportGrid() {
		desktop.grid(id.peek()).resize(metrics.peek())
	}

	function reportMonitors() {
		const connected = hyprMonitors.peek() ?? []
		const ids = (appMonitors.peek() ?? []).map(item => monitorKey(item, connected))
		desktop.setMonitors(ids, ids[0] ?? id.peek())
	}

	reportGrid()
	reportMonitors()
	const unsubscribers = [
		metrics.subscribe(reportGrid),
		id.subscribe(reportGrid),
		appMonitors.subscribe(reportMonitors),
		hyprMonitors.subscribe(reportMonitors),
	]
	onCleanup(() => unsubscribers.forEach(unsubscribe => unsubscribe()))

	return {
		monitor,
		id,
		geometry,
		metrics,
		files,
		positions,
		slotAt: (x, y) => pointToSlotIndex(x, y, metrics.peek()),
		move(paths, anchor, slot) {
			desktop.grid(id.peek()).move({ paths, slot, anchor })
		},
		import(paths, operation) {
			void desktop.grid(id.peek()).import(paths, operation)
		},
		paste() {
			void desktop.grid(id.peek()).paste()
		},
		createFolder() {
			return desktop.grid(id.peek()).createFolder()
		},
	}
}

const EMPTY_PATH_SET = new Set<string>()
const IMAGE_FILE_EXT_RE = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|jxl|png|svg|tiff?|webp)$/i

function isImageDesktopFile(file: DesktopFile) {
	return file.type.startsWith("image/") || file.type === "image"
		|| file.icon.includes("image") || IMAGE_FILE_EXT_RE.test(file.path)
}

function renameSelectionEnd(name: string) {
	if (!name || name === "." || name === "..")
		return name.length
	if (name.startsWith(".")) {
		const nextDot = name.indexOf(".", 1)
		return nextDot > 1 ? nextDot : name.length
	}
	const extension = name.indexOf(".")
	return extension > 0 ? extension : name.length
}

function focusRename(entry: Gtk.Entry) {
	entry.grab_focus()
	entry.select_region(0, renameSelectionEnd(entry.get_text()))
}

function isInsideIcon(widget: Gtk.Widget | null) {
	let current = widget
	while (current) {
		if (current.has_css_class?.("desktop-icon"))
			return true
		current = current.get_parent()
	}
	return false
}

function hitInteractiveTarget(gesture: Gtk.GestureClick, x: number, y: number) {
	const picked = gesture.get_widget()?.pick?.(x, y, Gtk.PickFlags.DEFAULT) ?? null
	return isInsideIcon(picked) || isInsideEntry(picked)
}

function keyPressed(grid: GridModel, key: number, state: number) {
	if (key === KEY_Shift_L || key === KEY_Shift_R) {
		menu.setShiftHeld(true)
		return false
	}
	if (!session.enabled.peek())
		return false
	if (session.rename.path.peek()) {
		if (key === KEY_Escape) {
			session.rename.cancel()
			return true
		}
		return false
	}

	const paths = session.selected.peek()
	const control = (state & ModifierType.CONTROL_MASK) !== 0
	if (key === KEY_Escape) {
		menu.hide()
		return true
	}
	if (key === KEY_Delete) {
		desktop.remove(paths, { permanently: (state & ModifierType.SHIFT_MASK) !== 0 })
		return true
	}
	if (control && (key === KEY_c || key === KEY_C)) {
		desktop.copy(paths)
		return true
	}
	if (control && (key === KEY_x || key === KEY_X)) {
		if (paths.length > 0)
			desktop.cut(paths)
		else
			void desktop.cancelCut()
		return true
	}
	if (control && (key === KEY_v || key === KEY_V)) {
		grid.paste()
		return true
	}
	if (key === KEY_Return) {
		if (paths.length === 1)
			desktop.open(paths)
		return true
	}
	if (key === KEY_F2) {
		if (paths.length === 1)
			session.rename.begin(paths[0])
		return true
	}
	return false
}

export function attachKeyboard(window: Gtk.Window, grid: GridModel) {
	const controller = new Gtk.EventControllerKey()
	controller.connect("key-pressed", (_self, key, _code, state) => keyPressed(grid, key, state))
	controller.connect("key-released", (_self, key) => {
		if (key === KEY_Shift_L || key === KEY_Shift_R)
			menu.setShiftHeld(false)
	})
	window.add_controller(controller)
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
				visible={preview.as(p => !p)}
				iconName={isCut.as(v => v ? "edit-cut" : iconName)}
				pixelSize={size}
				halign={CENTER}
				valign={CENTER}
				useFallback
			/>
			<Gtk.Picture
				class="desktop-icon-preview"
				visible={preview.as(p => !!p)}
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

type SelectionRect = { x: number, y: number, width: number, height: number }

function DesktopInput({ grid, drag }: { grid: GridModel, drag: DesktopDrag }) {
	const [selecting, setSelecting] = createState(false)
	const [selectionRect, setSelectionRect] = createState<SelectionRect | null>(null)
	let lastSelectionSample = 0

	function selectRectangle(x1: number, y1: number, x2: number, y2: number) {
		const next = selectPathsByRectangle(grid.files.peek(), grid.positions.peek(), grid.metrics.peek(), x1, y1, x2, y2)
		const current = session.selected.peek()
		if (current.length !== next.length || current.some((path, index) => path !== next[index]))
			session.select(next)
	}

	return (
		<>
			<Gtk.EventControllerMotion
				onEnter={menu.enterDesktop}
				onMotion={menu.enterDesktop}
				onLeave={menu.leaveDesktop}
			/>
			<Gtk.DropControllerMotion onMotion={(_, x, y) => drag.track(x, y)} onLeave={drag.leave} />
			<Gtk.GestureClick
				button={BUTTON_PRIMARY}
				onPressed={(gesture, _count, x, y) => {
					if (!session.enabled.peek() || hitInteractiveTarget(gesture, x, y))
						return
					if (session.rename.path.peek()) {
						session.rename.commit()
						return
					}
					session.select([])
					menu.hide()
				}}
			/>
			<Gtk.GestureClick
				button={BUTTON_SECONDARY}
				onPressed={(gesture, _count, x, y) => {
					if (!session.enabled.peek() || hitInteractiveTarget(gesture, x, y))
						return
					if (session.rename.path.peek())
						session.rename.commit()
					session.select([])
					const shift = ((gesture.get_current_event_state?.() ?? 0) & ModifierType.SHIFT_MASK) !== 0
					menu.show({ monitor: grid.monitor, monitorId: grid.id.peek(), x, y, shift })
				}}
			/>
			<Gtk.GestureDrag
				button={BUTTON_PRIMARY}
				onDragBegin={(gesture, x, y) => {
					if (!session.enabled.peek() || session.pressed.peek()) {
						gesture.reset()
						return
					}
					lastSelectionSample = 0
					setSelecting(true)
					setSelectionRect({ x, y, width: 0, height: 0 })
					menu.hide()
					selectRectangle(x, y, x, y)
				}}
				onDragUpdate={(_gesture, width, height) => {
					const rect = selectionRect.peek()
					if (!rect)
						return
					setSelectionRect({ ...rect, width, height })
					const now = GLib.get_monotonic_time()
					if (now - lastSelectionSample >= 16_000) {
						lastSelectionSample = now
						selectRectangle(rect.x, rect.y, rect.x + width, rect.y + height)
					}
				}}
				onDragEnd={(_gesture, width, height) => {
					setSelecting(false)
					const rect = selectionRect.peek()
					if (rect && (Math.abs(width) > 5 || Math.abs(height) > 5))
						selectRectangle(rect.x, rect.y, rect.x + width, rect.y + height)
					setSelectionRect(null)
					session.redraw()
				}}
			/>
			<box
				$type="overlay"
				visible={createComputed(() => session.enabled() && selecting())}
				class="selection-rectangle"
				halign={START}
				valign={START}
				marginStart={selectionRect.as(rect => rect ? Math.min(rect.x, rect.x + rect.width) : 0)}
				marginTop={selectionRect.as(rect => rect ? Math.min(rect.y, rect.y + rect.height) : 0)}
				widthRequest={selectionRect.as(rect => rect ? Math.abs(rect.width) : 0)}
				heightRequest={selectionRect.as(rect => rect ? Math.abs(rect.height) : 0)}
			/>
		</>
	)
}

export function DesktopGrid({ grid, drag }: { grid: GridModel, drag: DesktopDrag }) {
	let applyIconLayout: ((path: string, widget?: Gtk.Widget) => void) | null = null
	const widgets = new Map<string, Gtk.Widget>()

	const selectedPathSet = createComputed(() => {
		const selected = session.selected()
		return selected.length > 0 ? new Set(selected) : EMPTY_PATH_SET
	})

	const dragPackSet = createComputed(() => {
		const paths = drag.state().paths
		return paths.length > 0 ? new Set(paths) : EMPTY_PATH_SET
	})

	const cutPathSet = createComputed(() => {
		const clip = session.clipboard()
		if (!clip || clip.operation !== "cut" || clip.files.length === 0)
			return EMPTY_PATH_SET

		return new Set(clip.files)
	})

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
					visible={isInlineRename.as(v => !v)}
					label={file.name}
					maxWidthChars={labelPillChars}
					widthChars={labelPillChars}
					ellipsize={EllipsizeMode.END}
					justify={Justification.CENTER}
					lines={1}
					halign={CENTER}
					onNotifyLabel={self => updateLabelTooltip(self)}
					onNotifyVisible={self => updateLabelTooltip(self)}
					onNotifyMaxWidthChars={self => updateLabelTooltip(self)}
					$={self => {
						updateLabelTooltip(self)
					}}
				/>
				<entry
					visible={isInlineRename}
					text={session.rename.value}
					xalign={0.5}
					widthChars={labelChars}
					maxWidthChars={labelChars}
					halign={CENTER}
					sensitive
					canFocus
					onNotifyText={self => session.rename.setValue(self.get_text())}
					onActivate={session.rename.commit}
					onNotifyVisible={self => {
						if (self.visible)
							focusRename(self)
					}}
					onNotifyHasFocus={self => {
						if (self.has_focus) {
							hadFocus = true
							return
						}
						if (hadFocus && session.rename.path.peek() === file.path)
							session.rename.commit()
					}}
					$={self => {
						if (session.rename.path.peek() === file.path) {
							idle(() => {
								if (session.rename.path.peek() === file.path && self.get_visible())
									focusRename(self)
							})
						}
					}}
				/>
			</box>
		)
	}

	function FileIcon({
		file,
		iconMetrics,
		containerProps,
	}: {
		file: DesktopFile
		iconMetrics: Accessor<DesktopIconMetrics>
		containerProps?: Partial<Gtk.Box.ConstructorProps> & {
			$?: (self: Gtk.Widget) => void
		}
	}) {
		const isInlineRename = session.rename.path.as(path => path === file.path)
		const isCut = cutPathSet.as(paths => paths.has(file.path))
		const supportsPreview = isImageDesktopFile(file)
		const previewPaintable = createComputed(() => {
			if (isCut() || !supportsPreview)
				return null

			return textureFromUriSquareContainAsync(file.path, iconMetrics().iconPx)()
		})
		const iconPixelSize = iconMetrics.as(metrics => metrics.iconPx)
		const labelChars = iconMetrics.as(metrics => metrics.labelChars)
		const labelPillChars = iconMetrics.as(metrics => Math.max(4, metrics.labelChars - 1))
		let pendingSingleSelect = false
		let draggedSincePress = false

		const isSelected = selectedPathSet.as(paths => paths.has(file.path))
		const isDragPackMember = dragPackSet.as(paths => paths.size > 1 && paths.has(file.path))

		const cssClass = createComputed(() => {
			const sel = isSelected()
			const pack = isDragPackMember()
			const dragging = drag.state().paths.includes(file.path)
			return "desktop-icon"
				+ (sel  ? " selected" : "")
				+ (dragging ? " dragging"  : "")
				+ (pack ? " drag-pack" : "")
		})

		function handleClick(button: number, self: Gtk.GestureClick) {
			if (button === BUTTON_PRIMARY) {
				menu.hide()

				const state = self.get_current_event_state?.() ?? 0
				const ctrlHeld = (state & ModifierType.CONTROL_MASK) !== 0
				const current = session.selected.peek()

				if (ctrlHeld) {
					if (current.includes(file.path)) {
						session.select(current.filter(path => path !== file.path))
					} else {
						session.select([...current, file.path])
					}
					return
				}

				if (current.length > 1 && current.includes(file.path)) {
					pendingSingleSelect = true
					return
				}

				session.select([file.path])
			}

			if (button === BUTTON_SECONDARY) {
				if (!session.selected.peek().includes(file.path))
					session.select([file.path])
				const event = self.get_current_event()
				if (event) {
					const [success, x, y] = event.get_position()
					const shiftHeld = self.get_current_event_state
						? (self.get_current_event_state() & ModifierType.SHIFT_MASK) !== 0
						: false
					if (success)
						menu.show({ monitor: grid.monitor, monitorId: grid.id.peek(), x, y, shift: shiftHeld })
				}
			}
		}

		return (
			<box
				{...containerProps}
				class={cssClass}
				halign={START}
				valign={START}
				$={(self: Gtk.Widget) => {
					containerProps?.$?.(self)
					widgets.set(file.path, self)
					applyIconLayout?.(file.path, self)
					drag.attachSource(self, file.path, () => { draggedSincePress = true })

					onCleanup(() => {
						if (widgets.get(file.path) === self)
							widgets.delete(file.path)
					})
				}}
			>
				<Gtk.GestureClick
					button={0}
					onPressed={(self, nPress) => {
						if (session.rename.path.peek())
							return

						const clickedButton = self.get_current_button()
						if (clickedButton === BUTTON_PRIMARY) {
							session.press(file.path)
							pendingSingleSelect = false
							draggedSincePress = false
						}
						handleClick(clickedButton, self)

						if (clickedButton === BUTTON_PRIMARY && nPress === 2)
							desktop.open([file.path])
					}}
					onReleased={(self) => {
						if (self.get_current_button() !== BUTTON_PRIMARY)
							return
						if (pendingSingleSelect && !draggedSincePress) {
							session.select([file.path])
						}
						pendingSingleSelect = false
						session.press(null)
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
					/>
					<IconLabel
						file={file}
						isInlineRename={isInlineRename}
						labelChars={labelChars}
						labelPillChars={labelPillChars}
					/>
				</box>
			</box>
		)
	}

	const slotRects = createComputed(() => {
		const metrics = grid.metrics()
		const positions = grid.positions()
		const rects: Record<string, SlotRect> = {}

		for (const file of grid.files()) {
			const slotIndex = positions[file.path]
			if (slotIndex == null)
				continue
			rects[file.path] = slotIndexToRect(slotIndex, metrics)
		}
		return rects
	})

	function attachLayout(fixed: Gtk.Fixed) {
		const placeIcon = (widget: Gtk.Widget, rect: SlotRect) => {
			widget.set_size_request(rect.width, rect.height)
			fixed.move(widget, rect.x, rect.y)
		}

		const applyAllLayouts = () => {
			const rects = slotRects.peek()
			for (const [path, widget] of widgets) {
				const rect = rects[path]
				if (rect)
					placeIcon(widget, rect)
			}
		}

		applyIconLayout = (path: string, widget?: Gtk.Widget) => {
			const icon = widget ?? widgets.get(path)
			const rect = icon && slotRects.peek()[path]
			if (icon && rect)
				placeIcon(icon, rect)
		}

		const unsubscribe = slotRects.subscribe(applyAllLayouts)
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
				visible={session.enabled}
				class="desktop-container"
				hexpand
				vexpand
				halign={FILL}
				valign={FILL}
				$={fixed => {
					const unsubscribe = attachLayout(fixed)
					drag.attachTarget(fixed)
					onCleanup(() => {
						unsubscribe()
						applyIconLayout = null
					})
				}}
			>
				<For each={grid.files} id={file => file.path}>
					{(file: DesktopFile) => <FileIcon file={file} iconMetrics={session.iconMetrics} />}
				</For>
			</Gtk.Fixed>
			<DesktopInput grid={grid} drag={drag} />
			<DragLayer $type="overlay" drag={drag} />
		</overlay>
	)
}
