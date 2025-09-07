import { Astal, Gdk } from "ags/gtk4"
import giCairo from "cairo"

import options from "options"

export default function BarCorners(monitor: Gdk.Monitor) {
	const { corners, transparent } = options.bar
	const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
	const { EXCLUSIVE } = Astal.Exclusivity
	const { NONE } = Astal.Keymode

	return (
		<window
			name="screen-corner"
			class={corners.as(v => v ? "corners" : "")}
			visible={transparent.as(v => !v)}
			keymode={NONE}
			gdkmonitor={monitor}
			exclusivity={EXCLUSIVE}
			anchor={TOP | BOTTOM | LEFT | RIGHT}
			onNotifyVisible={w => {
				w.get_surface()?.set_input_region(new giCairo.Region)
			}}
			$={w => {
				w.get_surface()?.set_input_region(new giCairo.Region)
			}}
		>
			<box class="shadow">
				<box class="border">
					<box class="corner" hexpand />
				</box>
			</box>
		</window>
	)
}
