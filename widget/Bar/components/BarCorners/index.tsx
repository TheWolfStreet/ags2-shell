import { Astal, Gdk } from "ags/gtk4"
import { onCleanup } from "ags"

import { ignoreInput } from "$lib/utils"

import options from "options"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { EXCLUSIVE } = Astal.Exclusivity
const { NONE } = Astal.Keymode

const { corners, transparent } = options.bar

export function BarCorners({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {

	return (
		<window
			name="screen-corner"
			class={corners.as(v => v ? "corners" : "")}
			visible={transparent.as(v => !v)}
			keymode={NONE}
			gdkmonitor={gdkmonitor}
			exclusivity={EXCLUSIVE}
			anchor={TOP | BOTTOM | LEFT | RIGHT}
			onNotifyVisible={ignoreInput}
			$={(self) => {
				ignoreInput(self)
				onCleanup(() => {
					self.destroy()
				})
			}}
		>
			<box class="shadow">
				<box class="border">
					<box class="corner" hexpand />
				</box>
			</box>
		</window>
	) as Astal.Window
}
