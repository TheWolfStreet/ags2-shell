import app from "$lib/app"
import { Accessor, createBinding, createComputed, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle, type Timer } from "$lib/time"

import cairo from "cairo"
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
import { format_clock } from "$lib/time"
import { log_error } from "$lib/result"
import {
	schedule_monitor_window_release,
	track_monitor_fullscreen,
} from "$lib/windowing"
import { screen_capture } from "$service/screenCapture"

const { CENTER, START, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { WindowAnchor, Layer } = Astal
const { TOP, BOTTOM, LEFT, RIGHT } = WindowAnchor
const { TOP: TOP_LAYER } = Layer

const { transparent, position, corners } = options.bar
const { padding } = options.theme

function ScreenCorner({
	class: class_name,
	visible,
}: {
	class: Accessor<string>
	visible: Accessor<boolean>
}) {
	return (
		<box class={class_name} visible={visible} overflow={Gtk.Overflow.HIDDEN}>
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
			visible={createBinding(screen_capture, "recording")}
			onClicked={() => {
				log_error(
					screen_capture.stop_recording(),
					"bar.recording: Failed to stop recording",
				)
			}}
		>
			<box class="horizontal">
				<image iconName={icons.recorder.recording} />
				<label
					label={createBinding(screen_capture, "timer").as(
						(value) => format_clock(value) + " ",
					)}
				/>
			</box>
		</PanelButton>
	)
}

export function Bar({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
	let bar_window: Astal.Window | undefined
	let panel: Gtk.Widget | undefined
	let layout_surface: Gdk.Surface | null = null
	let layout_handler = 0
	let realize_handler = 0
	let position_timer: Timer | null = null

	const visible = track_monitor_fullscreen(gdkmonitor).as((value) => !value)

	const is_top = position.as((value) => value === "top-center")
	const corner_style = createComputed(() => {
		const radius =
			options.theme.roundness() * options.hyprland.gaps() * corners() * 0.01
		return radius >= padding() ? "corners" : "flat"
	})
	const corner_class = (edge: string) =>
		corner_style.as((style) => `screen-corner ${style} ${edge}`)
	const show_top = createComputed(() => !transparent() && is_top())
	const show_bottom = createComputed(() => !transparent() && !is_top())

	const sync_panel_area = () => {
		const surface = bar_window?.get_surface()
		if (!bar_window || !panel || !surface) return

		const [, height] = panel.measure(VERTICAL, -1)
		LayerShell.set_exclusive_zone(bar_window, height)

		const region = new cairo.Region()
		region.unionRectangle({
			x: 0,
			y: is_top.peek() ? 0 : surface.get_height() - height,
			width: surface.get_width(),
			height,
		})
		surface.set_input_region(region)
	}

	const reposition_unsubscribe = position.subscribe(() => {
		position_timer?.cancel()
		position_timer = idle(() => {
			position_timer = null
			if (!bar_window) return
			LayerShell.set_exclusive_zone(bar_window, 0)
			sync_panel_area()
		})
	})

	onCleanup(() => {
		position_timer?.cancel()
		if (layout_surface && layout_handler)
			layout_surface.disconnect(layout_handler)
		if (bar_window && realize_handler) bar_window.disconnect(realize_handler)
		schedule_monitor_window_release(bar_window)
		reposition_unsubscribe()
	})

	void (
		<window
			$={(self) => {
				bar_window = self
				const hook_surface = () => {
					const surface = self.get_surface()
					if (!surface || surface === layout_surface) return
					if (layout_surface && layout_handler)
						layout_surface.disconnect(layout_handler)
					layout_surface = surface
					layout_handler = surface.connect("layout", sync_panel_area)
					sync_panel_area()
				}
				if (self.get_realized()) hook_surface()
				realize_handler = self.connect("realize", hook_surface)
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
			<box
				orientation={VERTICAL}
				valign={is_top.as((top) => (top ? START : END))}
			>
				<ScreenCorner
					class={corner_class("bottom-center")}
					visible={show_bottom}
				/>
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
				<ScreenCorner class={corner_class("top-center")} visible={show_top} />
			</box>
		</window>
	)
}
