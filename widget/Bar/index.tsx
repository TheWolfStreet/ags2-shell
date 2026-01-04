import { Astal, Gdk, Gtk } from "ags/gtk4"
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

const { CENTER } = Gtk.Align
const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { EXCLUSIVE } = Astal.Exclusivity
const { transparent, position } = options.bar

export function Bar({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
	let win: Astal.Window

	onCleanup(() => {
		win.destroy()
	})

	return (
		<window
			$={self => {
				win = self
			}}
			name="bar"
			visible
			class={transparent.as(v => v ? "bar transparent" : "bar")}
			gdkmonitor={gdkmonitor}
			exclusivity={EXCLUSIVE}
			anchor={
				position.as((pos: string) => {
					const vertical = pos === 'top' ? TOP : pos === 'bottom' ? BOTTOM : TOP
					return vertical | LEFT | RIGHT
				})
			}
			application={app}
		>
			<centerbox valign={CENTER}>
				<box $type="start" class="horizontal" valign={CENTER}>
					<Launcher.Button />
					<Workspaces.Button />
					<Tasks />
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
		</window >
	)
}
