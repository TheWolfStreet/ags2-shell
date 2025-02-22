import { bind, Variable } from "astal"
import { App, Gtk, Astal } from "astal/gtk3"

import { ProgressBar } from "../../GtkWidgets"
import PopupWindow, { Position } from "../../PopupWindow"
import PanelButton from "./PanelButton"

import { bat } from "../../../lib/services"
import { initHook, onWindowToggle, toggleWindow } from "../../../lib/utils"
import options from "../../../options"

const { SLIDE_DOWN, SLIDE_UP } = Gtk.RevealerTransitionType

const { bar, batterystate } = options
const layout = Variable.derive([bar.position, batterystate.position], (bar, bs) => `${bar}-${bs}` as Position)

const percentage = bind(bat, "percentage")

export function BatteryLevel() {
	return (
		<PanelButton
			className="battery"
			onClick={() => toggleWindow("batterystate")}
			setup={self => {
				initHook(self, percentage, () => {
					self.toggleClassName("low", percentage.get() > options.bar.battery.low.get())
				})
				onWindowToggle(self, "batterystate", (w) => {
					self.toggleClassName("active", w.visible)
				})
			}}
			visible={bind(bat, "isPresent")}>
			<box spacing={6}>
				<icon icon={bind(bat, "batteryIconName")} useFallback />
				<label label={percentage.as(p =>
					`${Math.floor(p * 100)}% `
				)} />
			</box>
		</PanelButton>
	)
}

function BatteryState() {
	const remainingTime = Variable.derive(
		[bind(bat, "charging"), percentage, bind(bat, "timeToEmpty"), bind(bat, "timeToFull")],
		(charging, percent, drainRemaining, chargeRemaining) => {
			const time = charging ? chargeRemaining : drainRemaining

			let result = []
			if (time != 0) {
				const d = Math.floor(time / (24 * 60 * 60))
				const h = Math.floor((time % (24 * 60 * 60)) / (60 * 60))
				const m = Math.floor((time % (60 * 60)) / 60)
				const s = time % 60
				if (d > 0) result.push(`${d}d`)
				if (h > 0 || d > 0) result.push(`${h}h`)
				if (m > 0 || h > 0 || d > 0) result.push(`${m}m`)
				result.push(`${s}s`)
			}

			return percent == 1 ? "Fully charged" : (charging ? "Charging " : "Draining ") + (time == 0 ? "" : result.join(' '))
		}
	)

	return (
		<PopupWindow
			name="batterystate"
			exclusivity={Astal.Exclusivity.EXCLUSIVE}
			transitionType={options.bar.position(pos => pos === "top" ? SLIDE_DOWN : SLIDE_UP)}
			layout={layout.get()}
			child={
				<box className="batterystate vertical" vertical>
					<ProgressBar fraction={bind(bat, "percentage")} />
					<label className="remaining" label={remainingTime()} />
				</box>
			}
		/>
	)
}

export default function setupBatteryState() {
	App.add_window(BatteryState() as Gtk.Window)
	layout.subscribe(() => {
		(BatteryState() as Gtk.Window).close()
		App.remove_window(BatteryState() as Gtk.Window)
		App.add_window(BatteryState() as Gtk.Window)
	})
}
