import { createComputed, createRoot, createState } from "ags"
import app from "$lib/app"
import { Gtk } from "ags/gtk4"

import { create_pages } from "./components/pages"

import icons from "$lib/icons"
import { hyprland } from "$lib/hyprland"
import {
	focus_client,
	move_client_to_workspace_silent,
	raise_client,
} from "$lib/windowing"

import options, { collect_options, scaled } from "$shell/options"

export namespace Settings {
	const { SLIDE_LEFT_RIGHT } = Gtk.StackTransitionType
	const { CENTER } = Gtk.Align
	const { VERTICAL } = Gtk.Orientation

	let root: (() => void) | null = null

	function settings_client() {
		const app_id = app.get_application_id()
		return hyprland.clients.find(
			(client) => client.class === app_id && client.title === "Settings",
		)
	}

	async function bring_forward() {
		const client = settings_client()
		if (!client) return
		const workspace = hyprland.focusedWorkspace?.id
		if (workspace != null && client.workspace?.id !== workspace)
			await move_client_to_workspace_silent(workspace, client)
		await focus_client(client)
		await raise_client(client)
	}

	function open_settings() {
		const settings = ensure_window()
		app.get_window("quicksettings")?.hide()
		if (settings?.visible) void bring_forward()
		else settings?.show()
	}

	export function Button() {
		return (
			<button valign={CENTER} onClicked={open_settings}>
				<image iconName={icons.ui.settings} useFallback />
			</button>
		)
	}

	function Window() {
		const pages = create_pages()
		const page_buttons = pages.map((page) => {
			const name = page.name
			if (!name) throw new Error("Settings page has no name")
			return { name, icon_name: page.iconName }
		})
		if (!page_buttons.length) throw new Error("Settings has no pages")
		const all_opts = collect_options(options)

		let stack: Gtk.Stack | undefined
		const [current_page, set_current_page] = createState(page_buttons[0].name)

		const any_changed = createComputed(() =>
			all_opts.some((opt) => opt() !== opt.get_default()),
		)

		function reset_all() {
			all_opts.forEach((opt) => opt.reset())
		}

		function setup(self: Gtk.Stack) {
			stack = self
			const name = current_page.peek()
			if (self.get_child_by_name(name)) self.set_visible_child_name(name)
		}

		return (
			<Gtk.Window
				title="Settings"
				name="settings-dialog"
				class="settings-dialog"
				application={app}
				defaultHeight={scaled(600)}
				defaultWidth={scaled(500)}
				hideOnClose
				iconName={icons.ui.settings}
			>
				<box orientation={VERTICAL}>
					<centerbox class="header">
						<button
							class="reset"
							$type="start"
							valign={CENTER}
							sensitive={any_changed}
							tooltipText="Reset"
							onClicked={reset_all}
						>
							<image iconName={icons.ui.refresh} useFallback />
						</button>

						<box class="pager horizontal" $type="center">
							{page_buttons.map(({ name, icon_name }) => (
								<button
									class={current_page.as((v) => (v === name ? `active` : ""))}
									valign={CENTER}
									onClicked={() => {
										set_current_page(name)
										stack?.set_visible_child_name(name)
									}}
								>
									<box>
										<image iconName={icon_name} useFallback />
										<label label={name} />
									</box>
								</button>
							))}
						</box>

						<button
							class="close"
							$type="end"
							valign={CENTER}
							onClicked={() => app.get_window("settings-dialog")?.close()}
						>
							<image iconName={icons.ui.close} useFallback />
						</button>
					</centerbox>

					<stack transitionType={SLIDE_LEFT_RIGHT} $={setup}>
						{pages}
					</stack>
				</box>
			</Gtk.Window>
		)
	}

	function ensure_window() {
		const existing = app.get_window("settings-dialog")
		if (existing) return existing

		let window: Gtk.Window | null = null
		root ??= createRoot((dispose) => {
			window = Window() as Gtk.Window
			return dispose
		})
		return window
	}
}
