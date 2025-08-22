import app from "ags/gtk4/app"
import { createBinding, createComputed } from "ags"
import { Astal, Gtk } from "ags/gtk4"

import { bat } from "$lib/services"
import PopupWindow, { Position } from "widget/shared/PopupWindow"
import PanelButton from "./PanelButton"

import options from "options"
import { toggleWindow } from "$lib/utils"

const { bar, batterystate } = options
const layout = createComputed([bar.position, batterystate.position], (bar, bs) => `${bar}-${bs}` as Position)
const percentage = createBinding(bat, "percentage")

function BatteryState() {
	const remainingTime = createComputed(
		[createBinding(bat, "charging"), percentage, createBinding(bat, "timeToEmpty"), createBinding(bat, "timeToFull")],
		(charging: any, percent: number, drainRemaining: any, chargeRemaining: any) => {
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
			exclusivity={Astal.Exclusivity.NORMAL}
			layout={layout}
		>
			<box class="vertical" orientation={Gtk.Orientation.VERTICAL} >
				<Gtk.ProgressBar fraction={createBinding(bat, "percentage")} />
				<label class="remaining" label={remainingTime} />
			</box>
		</PopupWindow>
	) as Gtk.Window
}

export default function Battery() {
	return (
		<PanelButton
			name="batterystate"
			onClicked={() => toggleWindow("batterystate")}
			$={() => {
				const battery = BatteryState()
				app.add_window(battery)
				layout.subscribe(() => {
					battery.close()
					app.remove_window(battery)
					app.add_window(battery)
				})
			}}
			visible={createBinding(bat, "isPresent")}>
			<box class=" battery horizontal">
				<image iconName={createBinding(bat, "batteryIconName")} useFallback />
				<label label={percentage.as((p: number) =>
					`${Math.floor(p * 100)}% `
				)} />
			</box>
		</PanelButton>
	)
}
