import { Astal, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { onCleanup } from "ags"

import { Date } from "./components/Date"
import { Battery } from "./components/Battery"
import { Tasks, Tray, ColorPicker, ScreenRecord, Media } from "./components/Buttons"
import { Launcher } from "./components/Launcher"
import { Workspaces } from "./components/Overview"
import { Power } from "widget/PowerMenu"
import { Notifications } from "./components/Notifications"
import { QuickSettings } from "./components/QuickSettings"

import options from "options"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { EXCLUSIVE } = Astal.Exclusivity
const { transparent } = options.bar

export function Bar({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
	return (
		<window
			name="bar"
			visible
			hexpand
			class={transparent.as(v => v ? "bar transparent" : "bar")}
			gdkmonitor={gdkmonitor}
			exclusivity={EXCLUSIVE}
			anchor={
				options.bar.position.as((pos: string) => {
					const vertical = pos === 'top' ? TOP : pos === 'bottom' ? BOTTOM : TOP
					return vertical | LEFT | RIGHT
				})
			}
			application={app}
			$={(self) => {
				onCleanup(() => {
					self.destroy()
				})
			}}
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
					<QuickSettings.Button />
					<Battery.Button />
					<Power.Button />
				</box>
			</centerbox>
		</window >
	)
}
