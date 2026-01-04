import { createState, With } from "ags"
import { exec } from "ags/process"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "widget/Bar/components/PanelButton"

import icons from "$lib/icons"
import { onWindowToggle, toggleWindow } from "$lib/utils"

import options from "options"

const { END } = Gtk.Align
const { CROSSFADE } = Gtk.RevealerTransitionType
const { VERTICAL, HORIZONTAL } = Gtk.Orientation
const { layout, labels } = options.powermenu

type ActionType = "sleep" | "reboot" | "logout" | "shutdown"

const [cmd, set_cmd] = createState("")
const [title, set_title] = createState("")

const actionMap: Record<ActionType, [string, string]> = {
	sleep: ["systemctl suspend", "Sleep"],
	reboot: ["systemctl reboot", "Reboot"],
	logout: ["hyprctl dispatch exit", "Log Out"],
	shutdown: ["shutdown now", "Shutdown"],
}

export namespace Power {
	function Action({ action, label, onSelect }: { action: ActionType, label: string, onSelect: (a: ActionType) => void }) {
		return (
			<button onClicked={() => onSelect(action)}>
				<box orientation={VERTICAL}>
					<image iconName={icons.powermenu[action]} useFallback pixelSize={52} />
					<label label={label} visible={labels} />
				</box>
			</button>
		)
	}

	export function selAction(action: ActionType) {
		if (!app.get_window("verification")?.is_visible()) {
			const [command, windowTitle] = actionMap[action]
			set_cmd(command)
			set_title(windowTitle)
			toggleWindow("verification")
		}
	}

	export function Button() {
		return (
			<PanelButton onClicked={() => toggleWindow("powermenu")}>
				<image iconName={icons.powermenu.shutdown} useFallback />
			</PanelButton>
		)
	}

	export function Window() {
		return (
			<PopupWindow name="powermenu" transitionType={CROSSFADE} anchor={undefined} application={app}>
				<box class={layout.as(v => `powermenu horizontal ${v}`)}>
					<With value={layout}>
						{(v: string) => {
							if (v === "line") {
								return (
									<box orientation={HORIZONTAL} homogeneous>
										<Action action="shutdown" label="Shutdown" onSelect={Power.selAction} />
										<Action action="logout" label="Log Out" onSelect={Power.selAction} />
										<Action action="reboot" label="Reboot" onSelect={Power.selAction} />
										<Action action="sleep" label="Sleep" onSelect={Power.selAction} />
									</box>
								)
							} else if (v === "box") {
								return (
									<box>
										<box orientation={VERTICAL}>
											<Action action="shutdown" label="Shutdown" onSelect={Power.selAction} />
											<Action action="logout" label="Log Out" onSelect={Power.selAction} />
										</box>
										<box orientation={VERTICAL}>
											<Action action="reboot" label="Reboot" onSelect={Power.selAction} />
											<Action action="sleep" label="Sleep" onSelect={Power.selAction} />
										</box>
									</box>
								)
							}
							return <box />
						}}
					</With>
				</box>
			</PopupWindow>
		)
	}

	export function VerificationModal() {
		return (
			<PopupWindow name="verification" class="verification" transitionType={CROSSFADE} anchor={undefined} application={app}>
				<box class="verification" orientation={VERTICAL}>
					<box class="text-box" orientation={VERTICAL}>
						<label class="title" label={title} />
						<label class="desc" label="Confirm action" />
					</box>
					<box class="buttons horizontal" valign={END} vexpand homogeneous>
						<button
							onClicked={() => toggleWindow("verification")}
							$={self => onWindowToggle("verification", () => self.grab_focus())}
						>
							<label label="Cancel" />
						</button>
						<button
							onClicked={() => {
								exec(cmd.peek())
								toggleWindow("verification")
								toggleWindow("powermenu")
							}}
						>
							<label label="Confirm" />
						</button>
					</box>
				</box>
			</PopupWindow>
		)
	}
}
