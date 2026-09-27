// Shows a bar on each monitor and moves hidden bars to newly connected monitors.

import app from "ags/gtk4/app"
import { Accessor, createBinding, createComputed, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import giCairo from "cairo"
import LayerShell from "gi://Gtk4LayerShell"

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
	scheduleMonitorWindowRelease,
	trackMonitorFullscreen,
} from "$lib/windowing"
import { screenCapture } from "$service/screenCapture"

const { CENTER, START, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { WindowAnchor, Layer } = Astal
const { TOP, BOTTOM, LEFT, RIGHT } = WindowAnchor
const { TOP: TOP_LAYER } = Layer

const { transparent, position, corners } = options.bar
const { padding } = options.theme

function ScreenCorner({
	class: className,
	visible,
}: {
	class: Accessor<string>
	visible: Accessor<boolean>
}) {
	return (
		<box class={className} visible={visible} overflow={Gtk.Overflow.HIDDEN}>
			<box class="shadow" hexpand>
				<box class="border" hexpand>
					<box class="corner" hexpand />
				</box>
			</box>
		</box>
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
	let panel: Gtk.Widget | undefined

	const visible = trackMonitorFullscreen(gdkmonitor).as((value) => !value)

	const isTop = position.as((v) => v === "top-center")
	const cornerStyle = createComputed(() => {
		const radius =
			options.theme.roundness() * options.hyprland.gaps() * corners() * 0.01
		return radius >= padding() ? "corners" : "flat"
	})
	const cornerClass = (edge: string) =>
		cornerStyle.as((style) => `screen-corner ${style} ${edge}`)
	const showTop = createComputed(() => !transparent() && isTop())
	const showBottom = createComputed(() => !transparent() && !isTop())

	const syncPanelArea = () => {
		const surface = barWin?.get_surface()
		if (!barWin || !panel || !surface) return

		const [, height] = panel.measure(VERTICAL, -1)
		LayerShell.set_exclusive_zone(barWin, height)

		const region = new giCairo.Region()
		region.unionRectangle({
			x: 0,
			y: isTop.peek() ? 0 : surface.get_height() - height,
			width: surface.get_width(),
			height,
		})
		surface.set_input_region(region)
	}

	const repositionUnsub = position.subscribe(() => {
		idle(() => {
			if (!barWin) return
			LayerShell.set_exclusive_zone(barWin, 0)
			syncPanelArea()
		})
	})

	onCleanup(() => {
		scheduleMonitorWindowRelease(barWin)
		repositionUnsub()
	})

	void (
		<window
			$={(self) => {
				barWin = self
				const hookSurface = () =>
					self.get_surface()?.connect("layout", syncPanelArea)
				if (self.get_realized()) hookSurface()
				self.connect("realize", hookSurface)
			}}
			name="bar"
			visible={visible}
			class={transparent.as((v) => (v ? "bar transparent" : "bar"))}
			gdkmonitor={gdkmonitor}
			layer={TOP_LAYER}
			anchor={position.as((pos) => {
				return (pos === "bottom-center" ? BOTTOM : TOP) | LEFT | RIGHT
			})}
			application={app}
		>
			<box orientation={VERTICAL} valign={isTop.as((top) => (top ? START : END))}>
				<ScreenCorner class={cornerClass("bottom-center")} visible={showBottom} />
				<box
					class="panel"
					$={(self) => {
						panel = self
					}}
				>
					<centerbox hexpand valign={CENTER}>
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
				</box>
				<ScreenCorner class={cornerClass("top-center")} visible={showTop} />
			</box>
		</window>
	)
}
