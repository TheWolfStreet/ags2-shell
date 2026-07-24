// Shows dock icons and handles actions for windows, applications, separators, and trash.

import { Accessor, createBinding, createState } from "ags"
import { Gtk } from "ags/gtk4"
import { timeout } from "ags/time"

import AstalApps from "gi://AstalApps"
import AstalHyprland from "gi://AstalHyprland"

import icons from "$lib/icons"
import { hyprland } from "$service/system"
import { focusClientFullscreen, focusedClient, normalizeTaskClients, onClientClick } from "$lib/tasks"

import * as Trash from "widget/Dock/components/Trash"
import { DockItem, Side, isLeftPosition, isOnLeft } from "widget/Dock/components/items"

import options from "options"

const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { CENTER } = Gtk.Align

function DockIconBox({ children }: { children: JSX.Element | JSX.Element[] }) {
	const pos = options.dock.position
	return (
		<box
			class={pos.as(p => isLeftPosition(p) ? "dock-icon dock-vertical" : "dock-icon dock-horizontal")}
			orientation={pos.as(p => isLeftPosition(p) ? HORIZONTAL : VERTICAL)}
			halign={CENTER}
		>
			{children}
		</box>
	)
}

function GroupedIcon({ clients, appClass, iconName, iconSize }: {
	clients: AstalHyprland.Client[],
	appClass: string,
	iconName?: string,
	iconSize: Accessor<number>,
}) {
	const isFocused = focusedClient.as(currentClient =>
		currentClient != null && clients.some(client => client.address === currentClient.address)
	)

	const tooltipText = clients.length === 1
		? (clients[0].get_title() || appClass)
		: `${appClass} (${clients.length} windows)`

	function makeDots() {
		return Array.from({ length: Math.min(clients.length, 3) }, () => (
			<box class={isFocused.as(f => f ? "window-dot focused" : "window-dot")} halign={CENTER} valign={CENTER} />
		))
	}

	function focusNext() {
		const currentClient = focusedClient.peek()
		const idx = currentClient ? clients.findIndex(client => client.address === currentClient.address) : -1
		clients[idx >= 0 ? (idx + 1) % clients.length : 0].focus()
	}

	return (
		<DockIconBox>
			<box class="window-dots" orientation={isOnLeft.as(v => v ? VERTICAL : HORIZONTAL)} halign={CENTER} valign={CENTER} visible={isOnLeft}>
				{makeDots()}
			</box>
			<button class="app-button" tooltipText={tooltipText} canFocus={false}>
				<Gtk.GestureClick button={0} onPressed={self => {
					onClientClick(self.get_current_button(), {
						primary: focusNext,
						secondary: () => focusClientFullscreen(clients[0]),
						middle: () => clients.forEach(c => c.kill()),
					})
					self.reset()
				}} />
				<image halign={CENTER} valign={CENTER} iconName={iconName || appClass} pixelSize={iconSize} useFallback />
			</button>
			<box class="window-dots" orientation={HORIZONTAL} halign={CENTER} valign={CENTER} visible={isOnLeft.as(v => !v)}>
				{makeDots()}
			</box>
		</DockIconBox>
	)
}

function FavoriteIcon({ app: fav, iconSize }: { app: AstalApps.Application, iconSize: Accessor<number> }) {
	const [launching, setLaunching] = createState(false)
	return (
		<DockIconBox>
			<button
				class={launching.as(v => v ? "app-button launching" : "app-button")}
				tooltipText={fav.get_name()}
				canFocus={false}
				onClicked={() => {
					setLaunching(true)
					fav.launch()
					timeout(250, () => setLaunching(false))
				}}
			>
				<image halign={CENTER} valign={CENTER} iconName={fav.get_icon_name()} pixelSize={iconSize} />
			</button>
		</DockIconBox>
	)
}

function TrashIcon({ iconSize }: { iconSize: Accessor<number> }) {
	return (
		<DockIconBox>
			<button class="app-button" tooltipText="Trash" canFocus={false}
				onClicked={() => Trash.openOrFocus(
					normalizeTaskClients(hyprland.clients ?? []),
					hyprland.focusedWorkspace?.id ?? null,
				)}
			>
				<image
					halign={CENTER} valign={CENTER}
					iconName={Trash.hasItems.as(v => v ? icons.trashDetailed.full : icons.trashDetailed.empty)}
					pixelSize={iconSize} useFallback
				/>
			</button>
		</DockIconBox>
	)
}

export function renderItem(item: DockItem, side: Side, iconSize: Accessor<number>) {
	switch (item.kind) {
		case "group": return <GroupedIcon clients={item.clients} appClass={item.appClass} iconName={item.icon} iconSize={iconSize} />
		case "favorite": return <FavoriteIcon app={item.app} iconSize={iconSize} />
		case "trash": return <TrashIcon iconSize={iconSize} />
		case "separator": return side === "left"
			? <Gtk.Separator class="dock-separator" orientation={HORIZONTAL} />
			: <Gtk.Separator class="dock-separator" orientation={VERTICAL} valign={CENTER} heightRequest={iconSize} />
	}
}
