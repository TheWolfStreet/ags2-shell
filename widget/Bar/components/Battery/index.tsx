// Shows battery charge and power details in the bar and a popup.

import app from "ags/gtk4/app"
import { createBinding, createComputed } from "ags"
import { Astal, Gtk } from "ags/gtk4"

import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "../PanelButton"

import { formatDuration } from "$lib/format"
import { popupLayout } from "$lib/popup"
import { toggleWindow } from "$lib/windows"
import { battery } from "$service/system"

import options from "options"

const { VERTICAL } = Gtk.Orientation
const { NORMAL } = Astal.Exclusivity

export namespace Battery {
	export function Button() {
		return (
			<PanelButton
				name="batterystate"
				onClicked={() => toggleWindow("batterystate")}
				visible={isPresent}
			>
				<box class="battery horizontal">
					<image iconName={iconName} useFallback />
					<label label={percentage.as(v => `${Math.floor(v * 100)}%`)} />
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		const remainingTime = createRemainingTime(percentage)

		return (
			<PopupWindow
				name="batterystate"
				application={app}
				exclusivity={NORMAL}
				layout={layout}
			>
				<box class="batterystate vertical" orientation={VERTICAL}>
					<Gtk.ProgressBar
						class="percentage"
						fraction={percentage}
						widthRequest={125}
					/>
					<label label={remainingTime} />
				</box>
			</PopupWindow>
		) as Gtk.Window
	}

	const layout = popupLayout(options.bar.position, options.batterystate.position)
	const percentage = createBinding(battery, "percentage")
	const isPresent = createBinding(battery, "isPresent")
	const iconName = createBinding(battery, "batteryIconName")

	function createRemainingTime(percentage: () => number) {
		const charging = createBinding(battery, "charging")
		const timeToEmpty = createBinding(battery, "timeToEmpty")
		const timeToFull = createBinding(battery, "timeToFull")

		const remainingTime = createComputed(() => {
			if (percentage() === 1)
				return "Fully charged"

			const isCharging = charging()
			const seconds = isCharging ? timeToFull() : timeToEmpty()
			const prefix = isCharging ? "Charging" : "Draining"
			const formatted = formatDuration(seconds)

			return formatted ? `${prefix} ${formatted}` : prefix
		})

		return remainingTime
	}
}
