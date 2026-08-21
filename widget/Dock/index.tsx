// Shows a dock on each monitor.

import app from "ags/gtk4/app"
import { Accessor, createComputed, createState, For, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"

import { debounce } from "$lib/time"
import {
	scheduleMonitorWindowRelease,
	trackMonitorFullscreen,
} from "$lib/windowing"
import options from "$shell/options"
import { PopupWindow, type Position } from "widget/shared/PopupWindow"

import {
	createDockItems,
	renderDockItem,
	type DockSide,
} from "./components/DockItems"
import * as Trash from "./components/Trash"

const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { CENTER } = Gtk.Align
const { BOTTOM, LEFT, RIGHT, TOP: TOP_ANCHOR } = Astal.WindowAnchor
const { TOP } = Astal.Layer
const { EXCLUSIVE, IGNORE } = Astal.Exclusivity

const HOTZONE_BG = "rgba(0, 0, 0, 0.01)"
const HIDE_DELAY_MS = 250

const sideConfig = {
	left: {
		anchor: LEFT | TOP_ANCHOR | BOTTOM,
		layout: "center-left" as Position,
		orientation: VERTICAL,
	},
	bottom: {
		anchor: BOTTOM | LEFT | RIGHT,
		layout: "bottom-center" as Position,
		orientation: HORIZONTAL,
	},
}

function thicknessRequest(side: DockSide, thickness: Accessor<number>) {
	return side === "left"
		? { widthRequest: thickness, heightRequest: -1 }
		: { widthRequest: -1, heightRequest: thickness }
}

function trackMonitorGeometry(monitor: Gdk.Monitor) {
	const [geometry, setGeometry] = createState(monitor.get_geometry())
	const geometryHandler = monitor.connect("notify::geometry", () => {
		setGeometry(monitor.get_geometry())
	})

	onCleanup(() => monitor.disconnect(geometryHandler))
	return geometry
}

export namespace Dock {
	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		const { mode, position, scale } = options.dock
		const globalScale = options.scale
		const dockSide = position.as(
			(value) => (value === "center-left" ? "left" : "bottom") as DockSide,
		)
		const isAutohide = mode.as((value) => value === "autohide")
		const isStatic = mode.as((value) => value === "static")
		const isDockLocation = options.taskbar.location.as(
			(value) => value === "dock",
		)
		const shown = trackMonitorFullscreen(gdkmonitor).as((value) => !value)
		const geometry = trackMonitorGeometry(gdkmonitor)
		const dockItems = createDockItems(isDockLocation)
		const releaseTrashWatcher = Trash.acquireTrashWatcher()
		const windows: Gtk.Window[] = []

		const dockScale = createComputed(() => {
			const requestedScale = scale() / 100
			const itemCount = dockItems().length
			if (itemCount === 0) return requestedScale

			const monitorGeometry = geometry()
			const monitorLength =
				dockSide() === "left" ? monitorGeometry.height : monitorGeometry.width
			const globalScaleFactor = globalScale() / 100
			const usableLength = monitorLength * 0.88 - 2
			const totalSpacing = itemCount * 11 * globalScaleFactor
			const totalIconSize = itemCount * 64 * globalScaleFactor
			const scaleThatFits = (usableLength - totalSpacing) / totalIconSize

			return Math.max(0.3, Math.min(requestedScale, scaleThatFits))
		})
		const pixelScale = createComputed(() => dockScale() * (globalScale() / 100))
		const hotzoneThickness = createComputed(() =>
			Math.max(16, Math.round(22 * pixelScale())),
		)
		const windowThickness = createComputed(() =>
			Math.max(48, Math.round(94 * pixelScale())),
		)
		const edgeMargin = createComputed(() => Math.round(16 * pixelScale()))
		const iconSize = createComputed(() =>
			Math.max(16, Math.round(64 * pixelScale())),
		)
		const dockClassName = createComputed(
			() =>
				`dock-container ${dockSide() === "left" ? "dock-vertical" : "dock-horizontal"} ${position()} dock-${mode()}`,
		)

		const [hovered, setHovered] = createState(false)
		const hoverZones = new Set<string>()
		const hide = debounce(HIDE_DELAY_MS, () => setHovered(false))

		function enterHoverZone(zoneId: string) {
			hoverZones.add(zoneId)
			hide.cancel()
			if (!hovered()) setHovered(true)
		}

		function leaveHoverZone(zoneId: string) {
			hoverZones.delete(zoneId)
			if (hoverZones.size === 0) hide.call()
		}

		function bindHoverZone(window: Gtk.Window, zoneId: string) {
			const motion = new Gtk.EventControllerMotion()
			motion.connect("enter", () => enterHoverZone(zoneId))
			motion.connect("leave", () => leaveHoverZone(zoneId))
			window.add_controller(motion)
		}

		function sideActive(side: DockSide) {
			return createComputed(
				() => isDockLocation() && dockItems().length > 0 && dockSide() === side,
			)
		}

		function Hotzone({ side }: { side: DockSide }) {
			const active = sideActive(side)
			const zoneId = `hotzone-${side}`
			return (
				<window
					$={(self) => {
						windows.push(self)
						bindHoverZone(self, zoneId)
					}}
					name={`dock-hotzone-${side}`}
					layer={TOP}
					exclusivity={IGNORE}
					keymode={Astal.Keymode.NONE}
					focusable={false}
					anchor={sideConfig[side].anchor}
					application={app}
					visible={createComputed(() => shown() && active() && isAutohide())}
					{...thicknessRequest(side, hotzoneThickness)}
					gdkmonitor={gdkmonitor}
					css={`
						background: ${HOTZONE_BG};
					`}
					onNotifyVisible={(self) => {
						if (!self.get_visible()) leaveHoverZone(zoneId)
					}}
				>
					<box
						class="dock-hotzone"
						hexpand
						vexpand
						css={`
							background: ${HOTZONE_BG};
						`}
					/>
				</window>
			)
		}

		function DockSurface({ side }: { side: DockSide }) {
			const config = sideConfig[side]
			const active = sideActive(side)
			const zoneId = `dock-${side}`
			return (
				<PopupWindow
					$={(self) => {
						windows.push(self)
						bindHoverZone(self, zoneId)
					}}
					name={zoneId}
					layer={TOP}
					keymode={Astal.Keymode.NONE}
					focusable={false}
					exclusivity={createComputed(() =>
						active() && isStatic() ? EXCLUSIVE : IGNORE,
					)}
					anchor={config.anchor}
					application={app}
					visible={createComputed(
						() => shown() && active() && (isStatic() || hovered()),
					)}
					{...thicknessRequest(side, windowThickness)}
					gdkmonitor={gdkmonitor}
					layout={config.layout}
					handleClosing={false}
					onNotifyVisible={(self) => {
						if (!self.get_visible()) leaveHoverZone(zoneId)
					}}
				>
					<box
						class={dockClassName}
						css={createComputed(() => `--dock-scale: ${dockScale()};`)}
						orientation={config.orientation}
						halign={CENTER}
						marginStart={side === "left" ? edgeMargin : 0}
						marginBottom={side === "left" ? 0 : edgeMargin}
					>
						<For each={dockItems}>
							{(item) => renderDockItem(item, side, iconSize)}
						</For>
					</box>
				</PopupWindow>
			)
		}

		onCleanup(() => {
			releaseTrashWatcher()
			hoverZones.clear()
			hide.cancel()
			windows.forEach((window) => scheduleMonitorWindowRelease(window))
		})

		void (
			<>
				<Hotzone side="left" />
				<Hotzone side="bottom" />
				<DockSurface side="left" />
				<DockSurface side="bottom" />
			</>
		)
	}
}
