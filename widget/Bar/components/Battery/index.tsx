import app from "ags/gtk4/app"
import { createBinding, createComputed } from "ags"
import { Astal, Gtk } from "ags/gtk4"

import { PopupWindow, Position } from "widget/shared/PopupWindow"
import { PanelButton } from "../PanelButton"

import { toggleWindow } from "$lib/utils"
import { bat } from "$lib/services"

import options from "options"

const { bar, batterystate } = options
const layout = createComputed(() => `${bar.position()}-${batterystate.position()}` as Position)
const percentage = createBinding(bat, "percentage")

export namespace Battery {
	export function Button() {
		return (
			<PanelButton
				name="batterystate"
				onClicked={() => toggleWindow("batterystate")}
				visible={createBinding(bat, "isPresent")}>
				<box class="battery horizontal">
					<image iconName={createBinding(bat, "batteryIconName")} useFallback />
					<label label={percentage.as((p: number) =>
						`${Math.floor(p * 100)}%`
					)} />
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		const charging = createBinding(bat, "charging")
		const timeToEmpty = createBinding(bat, "timeToEmpty")
		const timeToFull = createBinding(bat, "timeToFull")
		const remainingTime = createComputed(() => {
			const time = charging() ? timeToFull() : timeToEmpty()
			const percent = percentage()

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

			return percent == 1 ? "Fully charged" : (charging() ? "Charging " : "Draining ") + (time == 0 ? "" : result.join(' '))
		})

		return (
			<PopupWindow
				name="batterystate"
				application={app}
				exclusivity={Astal.Exclusivity.NORMAL}
				layout={layout}
			>
				<box class="batterystate vertical" orientation={Gtk.Orientation.VERTICAL}>
					<Gtk.ProgressBar class="percentage" fraction={createBinding(bat, "percentage")} widthRequest={125} />
					<label label={remainingTime} />
				</box>
			</PopupWindow>
		) as Gtk.Window
	}

}
