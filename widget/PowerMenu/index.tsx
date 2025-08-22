import { Accessor, createState, With } from "ags"
import { exec } from "ags/process"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import PopupWindow from "widget/shared/PopupWindow"

import options from "options"
import icons from "$lib/icons"
import { onWindowToggle, toggleWindow } from "$lib/utils"
import PanelButton from "widget/Bar/components/PanelButton"

const { layout, labels } = options.powermenu
const { END } = Gtk.Align
const { CROSSFADE } = Gtk.RevealerTransitionType
const { VERTICAL, HORIZONTAL } = Gtk.Orientation

type Action = "sleep" | "reboot" | "logout" | "shutdown"

const [cmd, set_cmd] = createState("")
const [title, set_title] = createState("")

const actionMap: Record<Action, [string, string]> = {
	sleep: ["systemctl suspend", "Sleep"],
	reboot: ["systemctl reboot", "Reboot"],
	logout: ["hyprctl dispatch exit", "Log Out"],
	shutdown: ["shutdown now", "Shutdown"],
}

const selAction = (action: Action) => {
	const [cmd, title] = actionMap[action]
	set_cmd(cmd)
	set_title(title)
	toggleWindow("verification")
}

const confirm = () => {
	exec(cmd.get())
	toggleWindow("verification")
	toggleWindow("powermenu")
}

// TODO: Shared buttons, this shouldn't spawn the menus
export const PowerButton = () =>
	<PanelButton
		onClicked={() => toggleWindow("powermenu")}
		$={() => {
			app.add_window(Verification(title, confirm) as Gtk.Window)
			app.add_window(PowerMenu() as Gtk.Window)
		}}
	>
		<image iconName={icons.powermenu.shutdown} useFallback />
	</PanelButton >

const Verification = (title: Accessor<string>, onConfirm: () => void) => {
	return (

		<PopupWindow name="verification" class="verification" transitionType={CROSSFADE} anchor={undefined}>
			<box class="verification" orientation={VERTICAL}>
				<box class="text-box" orientation={VERTICAL}>
					<label class="title" label={title} />
					<label class="desc" label="Confirm action" />
				</box>
				<box class="buttons horizontal" valign={END} vexpand homogeneous>
					<button
						onClicked={() => {
							toggleWindow("verification")
						}}
						$={self => onWindowToggle("verification", () => self.grab_focus())}
					>
						<label label="Cancel" />
					</button>
					<button onClicked={onConfirm}>
						<label label="Confirm" />
					</button>
				</box>
			</box>
		</PopupWindow>
	)
}

const Action = (params: { action: Action; label: string; onSelect: (a: Action) => void }) => {
	const { action, label, onSelect } = params
	return (
		<button onClicked={() => onSelect(action)}>
			<box orientation={VERTICAL}>
				<image iconName={icons.powermenu[action]} useFallback pixelSize={52} />
				<label label={label} visible={labels} />
			</box>
		</button>
	)
}

const PowerMenu = () => {
	return (<PopupWindow name="powermenu" transitionType={CROSSFADE} anchor={undefined}>
		<box class={layout.as(v => `powermenu horizontal ${v}`)} >
			<With value={layout}>
				{(v: string) => {
					switch (v) {
						case "line":
							return (
								<box orientation={HORIZONTAL} homogeneous>
									<Action action="shutdown" label="Shutdown" onSelect={selAction} />
									<Action action="logout" label="Log Out" onSelect={selAction} />
									<Action action="reboot" label="Reboot" onSelect={selAction} />
									<Action action="sleep" label="Sleep" onSelect={selAction} />
								</box>
							)
						case "box":
							return (
								<box>
									<box orientation={VERTICAL}>
										<Action action="shutdown" label="Shutdown" onSelect={selAction} />
										<Action action="logout" label="Log Out" onSelect={selAction} />
									</box>
									<box orientation={VERTICAL}>
										<Action action="reboot" label="Reboot" onSelect={selAction} />
										<Action action="sleep" label="Sleep" onSelect={selAction} />
									</box>
								</box>
							)
						default:
							return <box />
					}
				}}
			</With>
		</box>
	</PopupWindow>
	)
}
