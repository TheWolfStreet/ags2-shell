// Shows power actions and asks for confirmation before running one.

import { createState, With } from "ags"
import { exec } from "ags/process"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import { PopupWindow } from "widget/Windowing/PopupWindow"
import { PanelButton } from "widget/Bar/components/PanelButton"

import icons from "$lib/icons"
import { onWindowToggle, toggleWindow } from "widget/Windowing/WindowControl"

import options from "options"

const { END } = Gtk.Align
const { CROSSFADE } = Gtk.RevealerTransitionType
const { VERTICAL, HORIZONTAL } = Gtk.Orientation
const { layout, labels } = options.powermenu

export namespace PowerMenu {
	export function Window() {
		return (
			<PopupWindow name="powermenu" transitionType={CROSSFADE} application={app}>
				<box class={layout.as(v => `powermenu horizontal ${v}`)}>
					<With value={layout}>
						{(v: string) => {
							if (v === "line") {
								return (
									<box orientation={HORIZONTAL} homogeneous>
										<Action action="shutdown" label="Shutdown" onSelect={PowerMenu.requestActionConfirmation} />
										<Action action="logout" label="Log Out" onSelect={PowerMenu.requestActionConfirmation} />
										<Action action="reboot" label="Reboot" onSelect={PowerMenu.requestActionConfirmation} />
										<Action action="sleep" label="Sleep" onSelect={PowerMenu.requestActionConfirmation} />
									</box>
								)
							} else if (v === "box") {
								return (
									<box>
										<box orientation={VERTICAL}>
											<Action action="shutdown" label="Shutdown" onSelect={PowerMenu.requestActionConfirmation} />
											<Action action="logout" label="Log Out" onSelect={PowerMenu.requestActionConfirmation} />
										</box>
										<box orientation={VERTICAL}>
											<Action action="reboot" label="Reboot" onSelect={PowerMenu.requestActionConfirmation} />
											<Action action="sleep" label="Sleep" onSelect={PowerMenu.requestActionConfirmation} />
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

	export function requestActionConfirmation(action: ActionType) {
		if (!app.get_window("verification")?.is_visible()) {
			setCmd(String(options.powermenu[action].peek()))
			setTitle(actionTitles[action])
			toggleWindow("verification")
		}
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

	export function Button() {
		return (
			<PanelButton onClicked={() => toggleWindow("powermenu")}>
				<image iconName={icons.powermenu.shutdown} useFallback />
			</PanelButton>
		)
	}

	type ActionType = "sleep" | "reboot" | "logout" | "shutdown"

	const [cmd, setCmd] = createState("")
	const [title, setTitle] = createState("")

	const actionTitles: Record<ActionType, string> = {
		sleep: "Sleep",
		reboot: "Reboot",
		logout: "Log Out",
		shutdown: "Shutdown",
	}

	function Action({ action, label, onSelect }: { action: ActionType, label: string, onSelect: (a: ActionType) => void }) {
		return (
			<button onClicked={() => onSelect(action)}>
				<box orientation={VERTICAL}>
					<image
						iconName={icons.powermenu[action]}
						useFallback
						pixelSize={options.scale.as(scale => Math.round(52 * scale / 100))}
					/>
					<label label={label} visible={labels} />
				</box>
			</button>
		)
	}
}
