// Shows a bar on each monitor and moves hidden bars to newly connected monitors.

import app from "ags/gtk4/app"
import { Accessor, createComputed, createState, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import { DateMenu } from "./components/DateMenu"
import { Battery } from "./components/Battery"
import { ColorPicker, MediaIndicator, RecordingIndicator, SystemTray, WindowList } from "./components/Buttons"
import { Launcher } from "./components/Launcher"
import { Overview } from "./components/Overview"
import { Notifications } from "./components/Notifications"
import { QuickSettings } from "./components/QuickSettings"

import { PowerMenu } from "widget/PowerMenu"

import options from "options"
import { trackMonitorFullscreen, type MonitorWindowController } from "widget/Windowing/MonitorState"
import { ignoreInput, scheduleMonitorWindowRelease } from "widget/Windowing/WindowControl"

const { CENTER } = Gtk.Align
const { WindowAnchor, Exclusivity, Layer, Keymode } = Astal
const { TOP, BOTTOM, LEFT, RIGHT } = WindowAnchor
const { EXCLUSIVE, IGNORE, NORMAL } = Exclusivity
const { TOP: TOP_LAYER } = Layer

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

		const nextMargin = height % 2 === 1 ? height - 1 : height
		if (nextMargin <= 0 || nextMargin === prevMargin)
			return

		prevMargin = nextMargin
		setMargin(nextMargin)
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
				<Overview.Button />
				<box visible={options.taskbar.location.as(v => v === "bar")}>
					<WindowList />
				</box>
			</box>

			<box $type="center" class="horizontal" valign={CENTER}>
				<DateMenu.Button />
			</box>

			<box $type="end" class="horizontal" valign={CENTER}>
				<MediaIndicator />
				<Notifications.Button />
				<ColorPicker />
				<SystemTray />
				<RecordingIndicator />
				<QuickSettings.Button />
				<Battery.Button />
				<PowerMenu.Button />
			</box>
		</centerbox>
	)
}

export function Bar({ gdkmonitor, initialVisible = true }: { gdkmonitor: Gdk.Monitor, initialVisible?: boolean }): MonitorWindowController {
	let barWin: Astal.Window | undefined
	let topWin: Astal.Window | undefined
	let bottomWin: Astal.Window | undefined

	const [shown, setShown] = createState(initialVisible)
	const fullscreen = trackMonitorFullscreen(gdkmonitor)
	const visible = createComputed(() => shown() && !fullscreen.fullscreen())

	const isTop = position.as(v => v === "top-center")
	const isTransparent = createComputed(() => transparent())
	const hasCorner = createComputed(() => {
		const radius = options.theme.roundness() * options.hyprland.gaps() * corners() * 0.01
		return radius >= padding()
	})
	const showTop = createComputed(() => visible() && !isTransparent() && isTop())
	const showBottom = createComputed(() => visible() && !isTransparent() && !isTop())

	const {
		margin,
		updateMargin,
		bindBarWindow,
		marginTrackingCleanup,
	} = setupMarginTracking()

	const controller: MonitorWindowController = {
		park: () => setShown(false),
		retarget(monitor) {
			fullscreen.retarget(monitor)
			barWin?.set_property("gdkmonitor", monitor)
			topWin?.set_property("gdkmonitor", monitor)
			bottomWin?.set_property("gdkmonitor", monitor)
			setShown(true)
			idle(updateMargin)
		},
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
		scheduleMonitorWindowRelease(barWin)
		scheduleMonitorWindowRelease(topWin)
		scheduleMonitorWindowRelease(bottomWin)
		paddingUnsub()
		repositionUnsub()
	})

	void (
		<>
			<window
				$={self => {
					barWin = self
					bindBarWindow(self)
				}}
				name="bar"
				visible={visible}
				class={transparent.as(v => v ? "bar transparent" : "bar")}
				gdkmonitor={gdkmonitor}
				layer={TOP_LAYER}
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

	return controller
}
