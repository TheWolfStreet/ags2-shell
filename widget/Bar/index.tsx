import { Astal, Gtk, Gdk } from "astal/gtk3"

import { ColorPicker, Media, PendingNotifications, PowerButton, ScreenRecord, SysTray, Taskbar } from "./components/Buttons"
import { BatteryLevel } from "./components/BatteryState"
import { Workspaces } from "./components/Overview"
import { SysIndicators } from "./components/QuickSettings"
import { DateMenuBtn } from "./components/DateMenu"
import { LauncherBtn } from "./components/Launcher"

import options from "../../options"
import { initHook } from "../../lib/utils"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { START, CENTER, END } = Gtk.Align

export default (monitor: Gdk.Monitor) =>
	<window
		className="bar"
		gdkmonitor={monitor}
		exclusivity={Astal.Exclusivity.EXCLUSIVE}
		setup={self =>
			initHook(self, options.bar.transparent, () => {
				self.toggleClassName("transparent", options.bar.transparent.get())
			})}
		anchor={options.bar.position(((pos) => pos === "top" ? (TOP | LEFT | RIGHT) : (BOTTOM | LEFT | RIGHT)))}>
		<centerbox>
			<box hexpand halign={START}>
				<LauncherBtn />
				<Workspaces />
				<Taskbar />
			</box>
			<box halign={CENTER}>
				<DateMenuBtn />
			</box>
			<box hexpand halign={END} >
				{Media()}
				<SysTray />
				<ColorPicker />
				<PendingNotifications />
				<ScreenRecord />
				<SysIndicators />
				<BatteryLevel />
				<PowerButton />
			</box>
		</centerbox>
	</window>
