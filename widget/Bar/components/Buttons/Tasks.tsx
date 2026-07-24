// Lists open windows in the bar and handles click and scroll actions.

import { createBinding, For } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import AstalHyprland from "gi://AstalHyprland"

import { getClientTitle } from "$lib/format"
import { createTaskItems, focusedClient, focusClientFullscreen, onClientClick } from "$lib/tasks"

export function Tasks() {
	const items = createTaskItems()
	return (
		<box class="tasks horizontal">
			<For each={items}>
				{client => <TaskEntry client={client} />}
			</For>
		</box>
	)
}

function TaskEntry({ client }: { client: AstalHyprland.Client }) {
	if (!client || client.class === "")
		return <box visible={false} />

	const focused = focusedClient.as(value => {
		return value?.address === client.address
	})

	return (
		<overlay tooltipText={getClientTitle(client)} valign={Gtk.Align.CENTER}>
			<Gtk.GestureClick
				button={0}
				onPressed={self => {
					onClientClick(self.get_current_button(), {
						primary: () => client.focus(),
						secondary: () => focusClientFullscreen(client),
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
