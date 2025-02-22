import { App, Astal } from "astal/gtk3"
import { GLib } from "astal"

import Auth from "./components/Auth"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

const GreeterWindow = () =>
	<window
		namespace="lockscreen"
		application={App}
		layer={Astal.Layer.OVERLAY}
		name="greeter"
		exclusivity={Astal.Exclusivity.IGNORE}
		anchor={TOP | BOTTOM | LEFT | RIGHT
		}
		keymode={Astal.Keymode.EXCLUSIVE}
		css={`
			background: url("file://${GLib.get_home_dir()}.config/background");
			background-size: cover;
		`}
	>
		<Auth />
	</window>


App.start({
	instanceName: "greeter",
	main() {
		GreeterWindow()
	},
})
