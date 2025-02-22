import { bind } from "astal"
import { App, Astal, Gtk } from "astal/gtk3"

import PopupWindow from "../../widget/PopupWindow"

import { powermenu } from "../../lib/services"
import { Action } from "../../service/powermenu"
import options from "../../options"
import icons from "../../lib/icons"
import { initHook, onWindowToggle, toggleWindow } from "../../lib/utils"

const { layout, labels } = options.powermenu
const { END } = Gtk.Align
const { CROSSFADE } = Gtk.RevealerTransitionType
const { OVERLAY } = Astal.Layer

export const VerificationPopup = () =>
	<PopupWindow name="verification" className="verification" transitionType={CROSSFADE} layer={OVERLAY}>
		<box className="verification" vertical>
			<box className="text-box" vertical>
				<label className="title" label={bind(powermenu, "title")} />
				<label className="desc" label="Confirm action" />
			</box>
			<box className="buttons horizontal" valign={END} vexpand homogeneous>
				<button
					onClicked={() => {
						toggleWindow("verification")
						if (App.get_window("powermenu")?.visible) {
							toggleWindow("powermenu")
						}
					}}
					setup={self => onWindowToggle(self, "verification", () => self.grab_focus())}>
					<label label={"Cancel"} />
				</button>
				<button onClicked={powermenu.exec}>
					<label label={"Confirm"} />
				</button>
			</box>
		</box>
	</PopupWindow>

const SysButton = (action: Action, label: string) =>
	<button onClicked={() => powermenu.action(action)}>
		<box className="system-button" vertical>
			<icon icon={icons.powermenu[action]} useFallback />
			<label label={label} visible={labels()} />
		</box>
	</button>

export default () =>
	<PopupWindow
		name="powermenu"
		layer={OVERLAY}
		transitionType={CROSSFADE}
	>
		<box
			className="powermenu horizontal"
			setup={self => {
				initHook(self, layout, () => {
					self.toggleClassName("box", layout.get() === "box")
					self.toggleClassName("line", layout.get() === "line")
				})
			}}
		>
			{layout(layout => {
				switch (layout) {
					case "line":
						return [
							SysButton("shutdown", "Shutdown"),
							SysButton("logout", "Log Out"),
							SysButton("reboot", "Reboot"),
							SysButton("sleep", "Sleep"),
						]
					case "box":
						return [
							<box vertical>
								{SysButton("shutdown", "Shutdown")}
								{SysButton("logout", "Log Out")}
							</box>,
							<box vertical>
								{SysButton("reboot", "Reboot")}
								{SysButton("sleep", "Sleep")}
							</box>,
						]
				}
			})}
		</box>
	</PopupWindow>
