// Lists open windows in the bar and handles click and scroll actions.

import { createBinding, For } from "ags"
import { Gtk } from "ags/gtk4"

import AstalHyprland from "gi://AstalHyprland"

import {
	createClientTitleAccessor,
	createWindowClientList,
	dispatchClientButtonAction,
	focusedWindowClient,
	focusClientAndToggleFullscreen,
} from "widget/Windowing/WindowClients"

export function WindowList() {
	const clients = createWindowClientList()
	return (
		<box class="tasks horizontal">
			<For each={clients}>
				{client => <TaskEntry client={client} />}
			</For>
		</box>
	)
}

function TaskEntry({ client }: { client: AstalHyprland.Client }) {
	if (!client || client.class === "")
		return <box visible={false} />

	const focused = focusedWindowClient.as(value => {
		return value?.address === client.address
	})

	return (
		<overlay tooltipText={createClientTitleAccessor(client)} valign={Gtk.Align.CENTER}>
			<Gtk.GestureClick
				button={0}
				onPressed={self => {
					dispatchClientButtonAction(self.get_current_button(), {
						primary: () => client.focus(),
						secondary: () => focusClientAndToggleFullscreen(client),
						middle: () => client.kill(),
					})
					self.reset()
				}}
			/>
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
	)
}
