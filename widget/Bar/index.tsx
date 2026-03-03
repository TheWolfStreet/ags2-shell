import app from "ags/gtk4/app"
import { Accessor, createComputed, createState, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import { Date } from "./components/Date"
import { Battery } from "./components/Battery"
import { Tasks, Tray, ColorPicker, ScreenRecord, Media } from "./components/Buttons"
import { Launcher } from "./components/Launcher"
import { Workspaces } from "./components/Overview"
import { Notifications } from "./components/Notifications"
import { QuickSettings } from "./components/QuickSettings"

import { Power } from "widget/PowerMenu"

import options from "options"
import { ignoreInput, releaseMonitorWindow } from "$lib/utils"
import type { MonitorControl } from "$lib/monitors"

const { CENTER } = Gtk.Align
const { WindowAnchor, Exclusivity, Layer, Keymode } = Astal
const { TOP, BOTTOM, LEFT, RIGHT } = WindowAnchor
const { EXCLUSIVE, IGNORE, NORMAL } = Exclusivity
const { OVERLAY } = Layer

const { transparent, position, corners } = options.bar
const { padding } = options.theme

const { NONE } = Keymode

type CornerProps = {
	name: string
	gdkmonitor: Gdk.Monitor
	class: Accessor<string>
	visible: Accessor<boolean>
	marginProp: "marginTop" | "marginBottom"
	margin: Accessor<number>
	anchor: number
	$?: (self: Astal.Window) => void
}

function setupMarginTracking() {
	let barWin: Astal.Window | undefined
	let tickID = 0
	let prevMargin = 0

	const [margin, setMargin] = createState(34)

	const updateMargin = () => {
		const height = Math.max(0, barWin?.get_allocated_height() ?? 0)
		if (height <= 0)
			return

		const next_margin = height % 2 === 1 ? height - 1 : height
		if (next_margin <= 0 || next_margin === prevMargin)
			return

		prevMargin = next_margin
		setMargin(next_margin)
	}

	const bindBarWindow = (self: Astal.Window) => {
		barWin = self
		updateMargin()
		tickID = self.add_tick_callback(() => {
			updateMargin()
			return true
		})
	}

	const destroy = () => {
		if (barWin && tickID > 0)
			barWin.remove_tick_callback(tickID)
	}

	return {
		margin,
		updateMargin,
		bindBarWindow,
		marginTrackingCleanup: destroy,
	}
}

function Corner({
	name,
	gdkmonitor,
	class: className,
	visible,
	marginProp,
	margin,
	anchor,
	$,
}: CornerProps) {
	return (
		<window
			$={(self) => {
				$?.(self)
				ignoreInput(self)
			}}
			name={name}
			class={className}
			visible={visible}
			keymode={NONE}
			gdkmonitor={gdkmonitor}
			application={app}
			exclusivity={IGNORE}
			layer={Layer.TOP}
			anchor={anchor}
			onNotifyVisible={ignoreInput}
			{...{ [marginProp]: margin }}
		>
			<box class="shadow">
				<box class="border">
					<box class="corner" hexpand />
				</box>
			</box>
		</window>
	)
}

function Layout() {
	return (
		<centerbox valign={CENTER}>
			<box $type="start" class="horizontal" valign={CENTER}>
				<Launcher.Button />
				<Workspaces.Button />
				<box visible={options.taskbar.location.as(v => v === "bar")}>
					<Tasks />
				</box>
			</box>

			<box $type="center" class="horizontal" valign={CENTER}>
				<Date.Button />
			</box>

			<box $type="end" class="horizontal" valign={CENTER}>
				<Media />
				<Notifications.Button />
				<ColorPicker />
				<Tray />
				<ScreenRecord />
				<QuickSettings.Button />
				<Battery.Button />
				<Power.Button />
			</box>
		</centerbox>
	)
}

export function Bar({ gdkmonitor, control, initialVisible = true }: { gdkmonitor: Gdk.Monitor, control?: Partial<MonitorControl>, initialVisible?: boolean }) {
	let barWin: Astal.Window | undefined
	let topWin: Astal.Window | undefined
	let bottomWin: Astal.Window | undefined

	const [shown, setShown] = createState(initialVisible)

	const isTop = position.as(v => v === "top-center")
	const isTransparent = createComputed(() => transparent())
	const hasCorner = createComputed(() => {
		const radius = options.theme.roundness() * options.hyprland.gaps() * corners() * 0.01
		return radius >= padding()
	})
	const showTop = createComputed(() => shown() && !isTransparent() && isTop())
	const showBottom = createComputed(() => shown() && !isTransparent() && !isTop())

	const {
		margin,
		updateMargin,
		bindBarWindow,
		marginTrackingCleanup,
	} = setupMarginTracking()

	if (control) {
		control.park = () => setShown(false)
		control.unpark = (mon) => {
			barWin?.set_property("gdkmonitor", mon)
			topWin?.set_property("gdkmonitor", mon)
			bottomWin?.set_property("gdkmonitor", mon)
			setShown(true)
			idle(updateMargin)
		}
	}

	const paddingUnsub = padding.subscribe(updateMargin)

	const repositionUnsub = position.subscribe(() => {
		idle(() => {
			if (!barWin)
				return

			barWin.set_exclusivity(NORMAL)
			barWin.set_exclusivity(EXCLUSIVE)
		})
	})

	onCleanup(() => {
		marginTrackingCleanup()
		releaseMonitorWindow(barWin)
		releaseMonitorWindow(topWin)
		releaseMonitorWindow(bottomWin)
		paddingUnsub()
		repositionUnsub()
	})

	return (
		<>
			<window
				$={self => {
					barWin = self
					bindBarWindow(self)
				}}
				name="bar"
				visible={shown}
				class={transparent.as(v => v ? "bar transparent" : "bar")}
				gdkmonitor={gdkmonitor}
				layer={OVERLAY}
				exclusivity={EXCLUSIVE}
				anchor={position.as(pos => {
					return (pos === "bottom-center" ? BOTTOM : TOP) | LEFT | RIGHT
				})}
				application={app}
			>
				<Layout />
			</window>

			<Corner
				name="screen-corner-top"
				gdkmonitor={gdkmonitor}
				class={createComputed(() => `${hasCorner() ? "corners" : "flat"} top-center`)}
				visible={showTop}
				marginProp="marginTop"
				margin={margin}
				anchor={TOP | LEFT | RIGHT}
				$={self => {
					topWin = self
				}}
			/>

			<Corner
				name="screen-corner-bottom"
				gdkmonitor={gdkmonitor}
				class={createComputed(() => `${hasCorner() ? "corners" : "flat"} bottom-center`)}
				visible={showBottom}
				marginProp="marginBottom"
				margin={margin}
				anchor={BOTTOM | LEFT | RIGHT}
				$={self => {
					bottomWin = self
				}}
			/>
		</>
	)
}
