import { createBinding, createComputed, For } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import AstalHyprland from "gi://AstalHyprland"

import { match_client_app } from "$lib/apps"
import {
	close_client,
	create_client_title_accessor,
	create_window_client_list,
	focused_window_client,
	focus_client,
	focus_client_and_toggle_fullscreen,
} from "$lib/windowing"

import options, { ui_scale } from "$shell/options"
import { applications } from "$service/apps"
import { ApplicationIcon, client_identity } from "widget/shared/ApplicationIcon"
import { client_icon_name } from "$lib/icons"

export function WindowList() {
	const clients = create_window_client_list(options.bar.taskbar.exclusive)
	return (
		<box class="tasks horizontal">
			<For each={clients}>{(client) => <TaskEntry client={client} />}</For>
		</box>
	)
}

function TaskEntry({ client }: { client: AstalHyprland.Client }) {
	const catalog = createBinding(applications, "list")
	const icon = createComputed(() => {
		const identity = client_identity(client)
		const app = match_client_app(catalog(), identity)
		return client_icon_name(app?.get_icon_name(), identity.class)
	})
	const icon_size = createComputed(() =>
		Math.max(8, Math.round(16 * ui_scale())),
	)
	const focused = focused_window_client.as(
		(value) => value?.address === client.address,
	)

	return (
		<button
			class="task"
			tooltipText={create_client_title_accessor(client)}
			valign={Gtk.Align.CENTER}
			onClicked={() => void focus_client(client)}
		>
			<Gtk.GestureClick
				button={Gdk.BUTTON_SECONDARY}
				onPressed={(self) => {
					focus_client_and_toggle_fullscreen(client)
					self.reset()
				}}
			/>
			<Gtk.GestureClick
				button={Gdk.BUTTON_MIDDLE}
				onPressed={(self) => {
					void close_client(client)
					self.reset()
				}}
			/>
			<overlay>
				<ApplicationIcon icon={icon} size={icon_size} />
				<box
					class="focused"
					$type="overlay"
					visible={focused}
					halign={Gtk.Align.CENTER}
					valign={Gtk.Align.START}
				/>
			</overlay>
		</button>
	)
}
