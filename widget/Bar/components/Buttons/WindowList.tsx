import { createBinding, For } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import AstalHyprland from "gi://AstalHyprland"

import {
	create_client_title_accessor,
	create_window_client_list,
	focused_window_client,
	focus_client_and_toggle_fullscreen,
} from "$lib/windowing"

import options from "$shell/options"

export function WindowList() {
	const clients = create_window_client_list(options.bar.taskbar.exclusive)
	return (
		<box class="tasks horizontal">
			<For each={clients}>
				{client => <TaskEntry client={client} />}
			</For>
		</box>
	)
}

function TaskEntry({ client }: { client: AstalHyprland.Client }) {
	const focused = focused_window_client.as(value => {
		return value?.address === client.address
	})

	return (
		<button class="task" tooltipText={create_client_title_accessor(client)} valign={Gtk.Align.CENTER}
			onClicked={() => client.focus()}>
			<Gtk.GestureClick
				button={Gdk.BUTTON_SECONDARY}
				onPressed={self => {
					focus_client_and_toggle_fullscreen(client)
					self.reset()
				}}
			/>
			<Gtk.GestureClick button={Gdk.BUTTON_MIDDLE} onPressed={self => {
				client.kill()
				self.reset()
			}} />
			<overlay>
				<image
					halign={Gtk.Align.CENTER}
					valign={Gtk.Align.CENTER}
					iconName={createBinding(client, "class")}
					useFallback
				/>
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
