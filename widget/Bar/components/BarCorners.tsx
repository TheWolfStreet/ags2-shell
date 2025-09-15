import { ignoreInput } from "$lib/utils"
import { Astal, Gdk } from "ags/gtk4"

import options from "options"

const { corners, transparent } = options.bar
const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { EXCLUSIVE } = Astal.Exclusivity
const { NONE } = Astal.Keymode

export function BarCorners(monitor: Gdk.Monitor) {
	return (
		<window
			name="screen-corner"
			class={corners.as(v => v ? "corners" : "")}
			visible={transparent.as(v => !v)}
			keymode={NONE}
			gdkmonitor={monitor}
			exclusivity={EXCLUSIVE}
			anchor={TOP | BOTTOM | LEFT | RIGHT}
			onNotifyVisible={ignoreInput}
			$={ignoreInput}
		>
			<box class="shadow">
				<box class="border">
					<box class="corner" hexpand />
				</box>
			</box>
		</window>
	)
}
