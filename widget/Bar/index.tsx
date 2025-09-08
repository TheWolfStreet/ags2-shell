import { Astal, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"

import { Date } from "./components/Date"
import { Battery } from "./components/Battery"
import { SysIndicators, Tasks, Tray, ColorPicker, ScreenRecord, Media } from "./components/Buttons"
import { Launcher } from "./components/Launcher"
import { Workspaces } from "./components/Overview"
import { Power } from "widget/PowerMenu"
import { Notifications } from "./components/Notifications"

import options from "options"

export default function Bar(gdkmonitor: Gdk.Monitor) {
	const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
	const { transparent } = options.bar

	return (
		<window
			name="bar"
			visible
			resizable={false}
			hexpand
			widthRequest={gdkmonitor.geometry.width}
			class={transparent.as(v => v ? "bar transparent" : "bar")}
			gdkmonitor={gdkmonitor}
			exclusivity={Astal.Exclusivity.EXCLUSIVE}
			anchor={
				options.bar.position.as((pos: string) => {
					const vertical = pos === 'top' ? TOP : pos === 'bottom' ? BOTTOM : TOP
					return vertical | LEFT | RIGHT
				})
			}
			application={app}
		>
			<centerbox>
				<box $type="start">
					<Launcher.Button />
					<Workspaces.Button />
					<Tasks />
				</box>

				<box $type="center">
					<Date.Button />
				</box>

				<box $type="end">
					<Media />
					<Notifications.Button />
					<ColorPicker />
					<Tray />
					<ScreenRecord />
					<SysIndicators />
					<Battery.Button />
					<Power.Button />
				</box>
			</centerbox>
		</window >
	)
}
