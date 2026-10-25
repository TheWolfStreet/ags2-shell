import { createState, With } from "ags"
import { execAsync } from "ags/process"
import { Gtk } from "ags/gtk4"
import app from "$lib/app"

import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "widget/Bar/components/PanelButton"

import icons from "$lib/icons"
import { attempt_async } from "$lib/result"

import options, { scaled } from "$shell/options"

export namespace PowerMenu {
	const { END } = Gtk.Align
	const { CROSSFADE } = Gtk.RevealerTransitionType
	const { VERTICAL, HORIZONTAL } = Gtk.Orientation
	const { layout, labels } = options.powermenu

	export function Button() {
		return (
			<PanelButton target_window="powermenu">
				<image iconName={icons.powermenu.shutdown} useFallback />
			</PanelButton>
		)
	}

	export function Window() {
		return (
			<PopupWindow
				name="powermenu"
				transitionType={CROSSFADE}
				application={app}
			>
				<box class={layout.as((value) => `powermenu horizontal ${value}`)}>
					<With value={layout}>
						{(value) => {
							if (value === "line")
								return (
									<box orientation={HORIZONTAL} homogeneous>
										<ActionButton action="shutdown" />
										<ActionButton action="logout" />
										<ActionButton action="reboot" />
										<ActionButton action="sleep" />
									</box>
								)
							if (value === "box")
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
							return <box />
						}}
					</With>
				</box>
			</PopupWindow>
		)
	}

	export function request_action_confirmation(action: action_type) {
		const verification = verification_window()
		if (!verification || verification.is_visible() || action_pending.peek())
			return
		set_selected_action(action)
		set_action_error("")
		verification.show()
	}

	export function VerificationModal() {
		return (
			<PopupWindow
				name="verification"
				transitionType={CROSSFADE}
				application={app}
				onNotifyVisible={(window) => {
					if (window.visible) cancel_button?.grab_focus()
				}}
			>
				<box class="verification" orientation={VERTICAL}>
					<box class="text-box" orientation={VERTICAL}>
						<label
							class="title"
							label={selected_action.as((action) =>
								action ? action_titles[action] : "",
							)}
						/>
						<label
							class="desc"
							label={action_error.as((error) => error || "Confirm action")}
						/>
					</box>
					<box class="buttons horizontal" valign={END} vexpand homogeneous>
						<button
							onClicked={() => verification_window()?.hide()}
							sensitive={action_pending.as((pending) => !pending)}
							$={(self) => {
								cancel_button = self
							}}
						>
							<label label="Cancel" />
						</button>
						<button
							onClicked={run_selected_action}
							sensitive={action_pending.as((pending) => !pending)}
						>
							<label label="Confirm" />
						</button>
					</box>
				</box>
			</PopupWindow>
		)
	}

	type action_type = "sleep" | "reboot" | "logout" | "shutdown"

	function verification_window() {
		return app.get_window("verification")
	}

	async function run_selected_action() {
		const action = selected_action.peek()
		if (!action || action_pending.peek()) return

		set_action_pending(true)
		verification_window()?.hide()
		app.get_window("powermenu")?.hide()
		const ran = await attempt_async(() =>
			execAsync(String(options.powermenu[action].peek())),
		)
		set_action_pending(false)
		if (ran.ok) return

		console.error(`powermenu.${action}: Failed to run action`, ran.err)
		set_action_error(`Could not ${action}. Check the shell log.`)
		verification_window()?.show()
	}

	const action_titles: Record<action_type, string> = {
		sleep: "Sleep",
		reboot: "Reboot",
		logout: "Log Out",
		shutdown: "Shutdown",
	}

	const [selected_action, set_selected_action] =
		createState<action_type | null>(null)
	const [action_pending, set_action_pending] = createState(false)
	const [action_error, set_action_error] = createState("")
	let cancel_button: Gtk.Button | null = null

	function ActionButton({ action }: { action: action_type }) {
		return (
			<button onClicked={() => request_action_confirmation(action)}>
				<box orientation={VERTICAL}>
					<image
						iconName={icons.powermenu[action]}
						useFallback
						pixelSize={scaled(52)}
					/>
					<label label={action_titles[action]} visible={labels} />
				</box>
			</button>
		)
	}
}
