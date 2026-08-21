// Shows power actions and asks for confirmation before running one.

import { createState, With } from "ags"
import { exec } from "ags/process"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "widget/Bar/components/PanelButton"

import icons from "$lib/icons"

import options from "$shell/options"

export namespace PowerMenu {
	export function Button() {
		return (
			<PanelButton
				targetWindow="powermenu"
			>
				<image iconName={icons.powermenu.shutdown} useFallback />
			</PanelButton>
		)
	}

	export function Window() {
		return (
			<PopupWindow name="powermenu" transitionType={CROSSFADE} application={app}>
				<box class={layout.as(v => `powermenu horizontal ${v}`)}>
					<With value={layout}>
						{(v: string) => {
							if (v === "line") {
								return (
									<box orientation={HORIZONTAL} homogeneous>
										<ActionButton action="shutdown" />
										<ActionButton action="logout" />
										<ActionButton action="reboot" />
										<ActionButton action="sleep" />
									</box>
								)
							} else if (v === "box") {
								return (
									<box>
										<box orientation={VERTICAL}>
											<ActionButton action="shutdown" />
											<ActionButton action="logout" />
										</box>
										<box orientation={VERTICAL}>
											<ActionButton action="reboot" />
											<ActionButton action="sleep" />
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
		const verification = app.get_window("verification")
		if (!verification || verification.is_visible()) return
		setSelectedAction(action)
		verification.show()
	}

	export function VerificationModal() {
		return (
			<PopupWindow
				name="verification"
				class="verification"
				transitionType={CROSSFADE}
				anchor={undefined}
				application={app}
				onNotifyVisible={window => {
					if (window.visible) cancelButton?.grab_focus()
				}}
			>
				<box class="verification" orientation={VERTICAL}>
					<box class="text-box" orientation={VERTICAL}>
						<label class="title" label={selectedAction.as(action => action ? actionTitles[action] : "")} />
						<label class="desc" label="Confirm action" />
					</box>
					<box class="buttons horizontal" valign={END} vexpand homogeneous>
						<button
							onClicked={() => app.get_window("verification")?.hide()}
							$={self => { cancelButton = self }}
						>
							<label label="Cancel" />
						</button>
						<button
							onClicked={() => {
								const action = selectedAction.peek()
								if (!action) return

								app.get_window("verification")?.hide()
								app.get_window("powermenu")?.hide()
								exec(String(options.powermenu[action].peek()))
							}}
						>
							<label label="Confirm" />
						</button>
					</box>
				</box>
			</PopupWindow>
		)
	}

	type ActionType = "sleep" | "reboot" | "logout" | "shutdown"

	const actionTitles: Record<ActionType, string> = {
		sleep: "Sleep",
		reboot: "Reboot",
		logout: "Log Out",
		shutdown: "Shutdown",
	}

	const [selectedAction, setSelectedAction] = createState<ActionType | null>(null)
	let cancelButton: Gtk.Button | null = null

	const { END } = Gtk.Align
	const { CROSSFADE } = Gtk.RevealerTransitionType
	const { VERTICAL, HORIZONTAL } = Gtk.Orientation
	const { layout, labels } = options.powermenu

	function ActionButton({ action }: { action: ActionType }) {
		return (
			<button onClicked={() => requestActionConfirmation(action)}>
				<box orientation={VERTICAL}>
					<image
						iconName={icons.powermenu[action]}
						useFallback
						pixelSize={options.scale.as(scale => Math.round(52 * scale / 100))}
					/>
					<label label={actionTitles[action]} visible={labels} />
				</box>
			</button>
		)
	}
}
