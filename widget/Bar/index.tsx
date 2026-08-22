// Shows a bar on each monitor and moves hidden bars to newly connected monitors.

import app from "ags/gtk4/app"
import {
	Accessor,
	createBinding,
	createComputed,
	createState,
	onCleanup,
} from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import { DateMenu } from "./components/DateMenu"
import { Battery } from "./components/Buttons/Battery"
import { ColorPicker } from "./components/Buttons/ColorPicker"
import { MediaIndicator } from "./components/Buttons/MediaIndicator"
import { SystemTray } from "./components/Buttons/SystemTray"
import { WindowList } from "./components/Buttons/WindowList"
import { PanelButton } from "./components/PanelButton"
import { Launcher } from "./components/Launcher"
import { Overview } from "./components/Overview"
import { Notifications } from "./components/Notifications"
import { QuickSettings } from "./components/QuickSettings"

import { PowerMenu } from "widget/PowerMenu"

import options from "$shell/options"
import icons from "$lib/icons"
import { formatClock } from "$lib/time"
import {
	ignoreInput,
	scheduleMonitorWindowRelease,
	trackMonitorFullscreen,
} from "$lib/windowing"
import { screenCapture } from "$service/screenCapture"

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
	let prevMargin = 0
	let unsubscribe: (() => void)[] = []

	const [margin, setMargin] = createState(34)

	const updateMargin = () => {
		const height = Math.max(0, barWin?.get_allocated_height() ?? 0)
		if (height <= 0) return

		const nextMargin = height % 2 === 1 ? height - 1 : height
		if (nextMargin <= 0 || nextMargin === prevMargin) return

		prevMargin = nextMargin
		setMargin(nextMargin)
	}

	const settle = () => {
		if (!barWin) return
		let frames = 0
		barWin.add_tick_callback(() => {
			updateMargin()
			return ++frames < 5
		})
	}

	const bindBarWindow = (self: Astal.Window) => {
		barWin = self
		updateMargin()
		settle()
		unsubscribe = [
			options.scale.subscribe(settle),
			options.font.subscribe(settle),
			options.theme.padding.subscribe(settle),
		]
	}

	const destroy = () => {
		unsubscribe.forEach((u) => u())
	}

	return {
		margin,
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
			namespace="screen-corner"
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

function RecordingIndicator() {
	return (
		<PanelButton
			class="recorder"
			visible={createBinding(screenCapture, "recording")}
			onClicked={() => screenCapture.stopRecording()}
		>
			<box class="horizontal">
				<image iconName={icons.recorder.recording} />
				<label
					label={createBinding(screenCapture, "timer").as(
						(value) => formatClock(value) + " ",
					)}
				/>
			</box>
		</PanelButton>
	)
}

export function Bar({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
	let barWin: Astal.Window | undefined
	let topWin: Astal.Window | undefined
	let bottomWin: Astal.Window | undefined

	const fullscreen = trackMonitorFullscreen(gdkmonitor)
	const visible = fullscreen.as((value) => !value)

	const isTop = position.as((v) => v === "top-center")
	const hasCorner = createComputed(() => {
		const radius =
			options.theme.roundness() * options.hyprland.gaps() * corners() * 0.01
		return radius >= padding()
	})
	const showTop = createComputed(() => visible() && !transparent() && isTop())
	const showBottom = createComputed(
		() => visible() && !transparent() && !isTop(),
	)

	const { margin, bindBarWindow, marginTrackingCleanup } = setupMarginTracking()

	const repositionUnsub = position.subscribe(() => {
		idle(() => {
			if (!barWin) return

			barWin.set_exclusivity(NORMAL)
			barWin.set_exclusivity(EXCLUSIVE)
		})
	})

	onCleanup(() => {
		marginTrackingCleanup()
		scheduleMonitorWindowRelease(barWin)
		scheduleMonitorWindowRelease(topWin)
		scheduleMonitorWindowRelease(bottomWin)
		repositionUnsub()
	})

	void (
		<>
			<window
				$={(self) => {
					barWin = self
					bindBarWindow(self)
				}}
				name="bar"
				visible={visible}
				class={transparent.as((v) => (v ? "bar transparent" : "bar"))}
				gdkmonitor={gdkmonitor}
				layer={TOP_LAYER}
				exclusivity={EXCLUSIVE}
				anchor={position.as((pos) => {
					return (pos === "bottom-center" ? BOTTOM : TOP) | LEFT | RIGHT
				})}
				application={app}
			>
				<centerbox valign={CENTER}>
					<box $type="start" class="horizontal" valign={CENTER}>
						<Launcher.Button />
						<Overview.Button />
						<box visible={options.taskbar.location.as((v) => v === "bar")}>
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
						<Battery />
						<PowerMenu.Button />
					</box>
				</centerbox>
			</window>

			<Corner
				name="screen-corner-top"
				gdkmonitor={gdkmonitor}
				class={createComputed(
					() => `${hasCorner() ? "corners" : "flat"} top-center`,
				)}
				visible={showTop}
				marginProp="marginTop"
				margin={margin}
				anchor={TOP | LEFT | RIGHT}
				$={(self) => {
					topWin = self
				}}
			/>

			<Corner
				name="screen-corner-bottom"
				gdkmonitor={gdkmonitor}
				class={createComputed(
					() => `${hasCorner() ? "corners" : "flat"} bottom-center`,
				)}
				visible={showBottom}
				marginProp="marginBottom"
				margin={margin}
				anchor={BOTTOM | LEFT | RIGHT}
				$={(self) => {
					bottomWin = self
				}}
			/>
		</>
	)
}
