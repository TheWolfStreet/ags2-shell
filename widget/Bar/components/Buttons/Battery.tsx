// Shows battery charge and power details in the bar and an attached popover.

import { createBinding, createComputed, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"

import AstalBattery from "gi://AstalBattery"

import options from "$shell/options"
import { createAnimatedPopover } from "widget/shared/AnimatedPopover"
import { PanelButton } from "../PanelButton"

const battery = AstalBattery.get_default()

const percentage = createBinding(battery, "percentage")
const isPresent = createBinding(battery, "isPresent")
const iconName = createBinding(battery, "batteryIconName")

function formatDuration(seconds: number) {
	const totalSeconds = Math.max(0, Math.floor(seconds))
	if (totalSeconds === 0) return ""

	if (totalSeconds < 60) return `${totalSeconds} sec`

	const days = Math.floor(totalSeconds / 86400)
	const hours = Math.floor((totalSeconds % 86400) / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const parts: string[] = []

	if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`)
	if (hours > 0) parts.push(`${hours} hr`)
	if (minutes > 0) parts.push(`${minutes} min`)
	return parts.join(" ")
}

export function Battery() {
	const charging = createBinding(battery, "charging")
	const timeToEmpty = createBinding(battery, "timeToEmpty")
	const timeToFull = createBinding(battery, "timeToFull")
	const remainingTime = createComputed(() => {
		if (percentage() === 1) return "Fully charged"

		const isCharging = charging()
		const formatted = formatDuration(isCharging ? timeToFull() : timeToEmpty())
		if (!formatted) return isCharging ? "Charging" : "Draining"

		return isCharging ? `${formatted} until full` : `${formatted} remaining`
	})

	const popoverPosition = () =>
		options.bar.position.peek() === "top-center"
			? Gtk.PositionType.BOTTOM
			: Gtk.PositionType.TOP
	const { popover, revealer } = createAnimatedPopover(popoverPosition(), false)
	revealer.set_child(
		(
			<box class="batterystate vertical" orientation={Gtk.Orientation.VERTICAL}>
				<Gtk.ProgressBar
					class="percentage"
					fraction={percentage}
					widthRequest={options.scale.as((scale) =>
						Math.round((125 * scale) / 100),
					)}
				/>
				<label label={remainingTime} />
			</box>
		) as Gtk.Widget,
	)

	const unsubscribe = options.bar.position.subscribe(() =>
		popover.set_position(popoverPosition()),
	)
	onCleanup(() => {
		unsubscribe()
		popover.unparent()
	})

	return (
		<PanelButton
			visible={isPresent}
			onClicked={() => popover.popup()}
			$={(self) => popover.set_parent(self)}
		>
			<box class="battery horizontal">
				<image iconName={iconName} useFallback />
				<label
					label={percentage.as((value) => `${Math.floor(value * 100)}%`)}
				/>
			</box>
		</PanelButton>
	)
}
