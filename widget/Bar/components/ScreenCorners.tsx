import Cairo10 from "gi://cairo"
import { Gdk, Astal } from "astal/gtk3"

import { initHook } from "../../../lib/utils"
import options from "../../../options"

const { corners, transparent } = options.bar
const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

export default (monitor: Gdk.Monitor) =>
	<window
		gdkmonitor={monitor}
		name={`corner${monitor}`}
		className="screen-corner"

		exclusivity={Astal.Exclusivity.EXCLUSIVE}
		anchor={TOP | BOTTOM | LEFT | RIGHT}
		clickThrough
		setup={self => {
			// Create an empty region, effectively receiving no input
			self.input_shape_combine_region(new Cairo10.Region)
			initHook(self, corners, () => {
				self.toggleClassName("corners", corners.get() > 0)
			})
			initHook(self, transparent, () => {
				self.toggleClassName("hidden", transparent.get())
			})
		}}
	>
		<box className="shadow">
			<box className="border" vexpand hexpand>
				<box className="corner" vexpand hexpand />
			</box>
		</box>
	</window>
