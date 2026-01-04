import { Astal, Gdk } from "ags/gtk4"
import { onCleanup } from "ags"
import app from "ags/gtk4/app"

import { ignoreInput } from "$lib/utils"

import options from "options"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { EXCLUSIVE } = Astal.Exclusivity
const { NONE } = Astal.Keymode

const { corners, transparent, position } = options.bar

export function BarCorners({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
	let win: Astal.Window

	onCleanup(() => {
		win.destroy()
	})

	return (
		<window
			$={(self) => {
				win = self
				ignoreInput(self)
			}}
			name="screen-corner"
			class={position.as(pos => `${corners.peek() ? "corners" : ""} ${pos}`)}
			visible={transparent.as(v => !v)}
			keymode={NONE}
			gdkmonitor={gdkmonitor}
			application={app}
			exclusivity={EXCLUSIVE}
			anchor={TOP | BOTTOM | LEFT | RIGHT}
			onNotifyVisible={ignoreInput}
		>
			<box class="shadow">
				<box class="border">
					<box class="corner" hexpand />
				</box>
			</box>
		</window>
	) as Astal.Window
}
