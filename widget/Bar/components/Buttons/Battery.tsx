import { createBinding, createComputed, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"

import AstalBattery from "gi://AstalBattery"

import options from "$shell/options"
import { create_animated_popover } from "widget/shared/AnimatedPopover"
import { PanelButton } from "../PanelButton"

const battery = AstalBattery.get_default()

const percentage = createBinding(battery, "percentage")
const is_present = createBinding(battery, "isPresent")
const icon_name = createBinding(battery, "batteryIconName")

function format_duration(seconds: number) {
	const total_seconds = Math.max(0, Math.floor(seconds))
	if (total_seconds === 0) return ""

	if (total_seconds < 60) return `${total_seconds} sec`

	const days = Math.floor(total_seconds / 86400)
	const hours = Math.floor((total_seconds % 86400) / 3600)
	const minutes = Math.floor((total_seconds % 3600) / 60)
	const parts: string[] = []

	if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`)
	if (hours > 0) parts.push(`${hours} hr`)
	if (minutes > 0) parts.push(`${minutes} min`)
	return parts.join(" ")
}

export function Battery() {
	const charging = createBinding(battery, "charging")
	const time_to_empty = createBinding(battery, "timeToEmpty")
	const time_to_full = createBinding(battery, "timeToFull")
	const remaining_time = createComputed(() => {
		if (percentage() === 1) return "Fully charged"

		const is_charging = charging()
		const formatted = format_duration(
			is_charging ? time_to_full() : time_to_empty(),
		)
		if (!formatted) return is_charging ? "Charging" : "Draining"

		return is_charging ? `${formatted} until full` : `${formatted} remaining`
	})

	const popover_position = () =>
		options.bar.position.peek() === "top-center"
			? Gtk.PositionType.BOTTOM
			: Gtk.PositionType.TOP
	const { popover, revealer, dispose } = create_animated_popover(
		popover_position(),
		false,
	)
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
				<label label={remaining_time} />
			</box>
		) as Gtk.Widget,
	)

	const unsubscribe = options.bar.position.subscribe(() =>
		popover.set_position(popover_position()),
	)
	onCleanup(() => {
		unsubscribe()
		dispose()
		popover.unparent()
	})

	return (
		<PanelButton
			visible={is_present}
			onClicked={() => popover.popup()}
			$={(self) => popover.set_parent(self)}
		>
			<box class="battery horizontal">
				<image iconName={icon_name} useFallback />
				<label
					label={percentage.as((value) => `${Math.floor(value * 100)}%`)}
				/>
			</box>
		</PanelButton>
	)
}
