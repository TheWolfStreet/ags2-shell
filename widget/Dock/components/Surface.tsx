import app from "ags/gtk4/app"
import { Accessor, For, createComputed } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"

import { renderItem } from "widget/Dock/components/Icons"
import { Hover } from "widget/Dock/components/hover"
import { DockItem, Side, isOnLeft } from "widget/Dock/components/items"
import { PopupWindow, Position } from "widget/shared/PopupWindow"

const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { CENTER } = Gtk.Align
const { BOTTOM, LEFT, RIGHT, TOP: TOP_ANCHOR } = Astal.WindowAnchor
const { TOP } = Astal.Layer
const { EXCLUSIVE, IGNORE } = Astal.Exclusivity

const HOTZONE_BG = "rgba(0, 0, 0, 0.01)"

export type DockView = {
	gdkmonitor: Gdk.Monitor
	windows: Gtk.Window[]
	shown: Accessor<boolean>
	hover: Hover
	dockItems: Accessor<DockItem[]>
	isDockLocation: Accessor<boolean>
	isAutohide: Accessor<boolean>
	isStatic: Accessor<boolean>
	hotzoneThickness: Accessor<number>
	windowThickness: Accessor<number>
	edgeMargin: Accessor<number>
	iconSize: Accessor<number>
	dockClassName: Accessor<string>
}

const sideConfig = {
	left: { anchor: LEFT | TOP_ANCHOR | BOTTOM, layout: "center-left" as Position, orientation: VERTICAL },
	bottom: { anchor: BOTTOM | LEFT | RIGHT, layout: "bottom-center" as Position, orientation: HORIZONTAL },
}

function thicknessRequest(side: Side, thickness: Accessor<number>) {
	return side === "left"
		? { widthRequest: thickness, heightRequest: -1 }
		: { widthRequest: -1, heightRequest: thickness }
}

function bindHoverZone(view: DockView, window: Gtk.Window, zoneId: string) {
	const motion = new Gtk.EventControllerMotion()
	motion.connect("enter", () => view.hover.enter(zoneId))
	motion.connect("leave", () => view.hover.leave(zoneId))
	window.add_controller(motion)
}

function sideActive(view: DockView, side: Side) {
	return createComputed(() =>
		view.isDockLocation() && view.dockItems().length > 0 && isOnLeft() === (side === "left"))
}

export function Hotzone({ view, side }: { view: DockView, side: Side }) {
	const active = sideActive(view, side)
	const zoneId = `hotzone-${side}`
	return (
		<window
			$={self => { view.windows.push(self); bindHoverZone(view, self, zoneId) }}
			name={`dock-hotzone-${side}`}
			layer={TOP} exclusivity={IGNORE} keymode={Astal.Keymode.NONE} focusable={false}
			anchor={sideConfig[side].anchor}
			application={app}
			visible={createComputed(() => view.shown() && active() && view.isAutohide())}
			{...thicknessRequest(side, view.hotzoneThickness)}
			gdkmonitor={view.gdkmonitor}
			css={`background: ${HOTZONE_BG};`}
			onNotifyVisible={self => { if (!self.get_visible()) view.hover.leave(zoneId) }}
		>
			<box class="dock-hotzone" hexpand vexpand css={`background: ${HOTZONE_BG};`} />
		</window>
	)
}

export function DockSurface({ view, side }: { view: DockView, side: Side }) {
	const cfg = sideConfig[side]
	const active = sideActive(view, side)
	const zoneId = `dock-${side}`
	return (
		<PopupWindow
			$={self => { view.windows.push(self); bindHoverZone(view, self, zoneId) }}
			name={zoneId}
			layer={TOP} keymode={Astal.Keymode.NONE} focusable={false}
			exclusivity={createComputed(() => active() && view.isStatic() ? EXCLUSIVE : IGNORE)}
			anchor={cfg.anchor}
			application={app}
			visible={createComputed(() => view.shown() && active() && (view.isStatic() || view.hover.hovered()))}
			{...thicknessRequest(side, view.windowThickness)}
			gdkmonitor={view.gdkmonitor}
			layout={cfg.layout}
			handleClosing={false}
			css="background: transparent;"
			onNotifyVisible={self => { if (!self.get_visible()) view.hover.leave(zoneId) }}
		>
			<box
				class={view.dockClassName}
				orientation={cfg.orientation}
				halign={CENTER}
				marginStart={side === "left" ? view.edgeMargin : 0}
				marginBottom={side === "left" ? 0 : view.edgeMargin}
			>
				<For each={view.dockItems}>
					{item => renderItem(item, side, view.iconSize)}
				</For>
			</box>
		</PopupWindow>
	)
}
