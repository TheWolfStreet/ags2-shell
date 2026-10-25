import { Accessor, createBinding, createComputed, createState } from "ags"
import { Gtk } from "ags/gtk4"
import { timeout } from "$lib/time"

import AstalApps from "gi://AstalApps"
import AstalHyprland from "gi://AstalHyprland"

import icons, { client_icon_name } from "$lib/icons"
import { log_error } from "$lib/result"
import {
	close_client,
	create_window_client_list,
	dispatch_client_button_action,
	focused_window_client,
	focus_client,
	focus_client_and_toggle_fullscreen,
} from "$lib/windowing"
import { launch_app, match_client_app } from "$lib/apps"
import { applications } from "$service/apps"
import options from "$shell/options"
import { ApplicationIcon, client_identity } from "widget/shared/ApplicationIcon"

import * as Trash from "./trash"

export type dock_side = "left" | "bottom"

type dock_item =
	| {
			kind: "group"
			clients: AstalHyprland.Client[]
			app_class: string
			icon?: string
	  }
	| { kind: "favorite"; app: AstalApps.Application }
	| { kind: "separator" }
	| { kind: "trash" }

const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { CENTER } = Gtk.Align

type running_groups = {
	groups: Map<string, AstalHyprland.Client[]>
	matched_apps: Map<string, AstalApps.Application | null | undefined>
}

export function side_class(side: dock_side) {
	if (side === "left") return "dock-vertical"
	return "dock-horizontal"
}

function app_entry(app: AstalApps.Application | null | undefined) {
	return app?.get_entry() ?? null
}

function group_running_clients(
	running: AstalHyprland.Client[],
	catalog: AstalApps.Application[],
): running_groups {
	const groups = new Map<string, AstalHyprland.Client[]>()
	const matched_apps = new Map<
		string,
		AstalApps.Application | null | undefined
	>()
	for (const client of running) {
		const identity = client_identity(client)
		const app_class = identity.class
		const group = groups.get(app_class)
		if (group) group.push(client)
		else groups.set(app_class, [client])
		const match = match_client_app(catalog, identity)
		if (!matched_apps.has(app_class)) {
			matched_apps.set(app_class, match)
			continue
		}
		if (app_entry(matched_apps.get(app_class)) !== app_entry(match))
			matched_apps.set(app_class, undefined)
	}
	return { groups, matched_apps }
}

function group_item(
	app_class: string,
	clients: AstalHyprland.Client[],
	matched_apps: running_groups["matched_apps"],
): dock_item {
	return {
		kind: "group",
		clients,
		app_class,
		icon: matched_apps.get(app_class)?.get_icon_name() || undefined,
	}
}

function favorite_items(
	favorites: AstalApps.Application[],
	{ groups, matched_apps }: running_groups,
): dock_item[] {
	const items: dock_item[] = []
	for (const favorite of favorites) {
		const matching_group = [...groups].find(
			([app_class]) =>
				matched_apps.get(app_class)?.get_entry() === favorite.get_entry(),
		)
		if (!matching_group) {
			items.push({ kind: "favorite", app: favorite })
			continue
		}
		const [app_class, clients] = matching_group
		items.push(group_item(app_class, clients, matched_apps))
		groups.delete(app_class)
	}
	return items
}

function same_item(item: dock_item, previous: dock_item) {
	if (item.kind === "separator" || item.kind === "trash")
		return previous.kind === item.kind
	if (item.kind === "favorite")
		return previous.kind === "favorite" && item.app === previous.app
	return (
		previous.kind === "group" &&
		item.app_class === previous.app_class &&
		item.icon === previous.icon &&
		item.clients.length === previous.clients.length &&
		item.clients.every((client, i) => client === previous.clients[i])
	)
}

function shows_favorites(location: string) {
	return location === "dock" || location === "both"
}

export function create_dock_items(is_dock_location: Accessor<boolean>) {
	const running_clients = create_window_client_list(
		options.bar.taskbar.exclusive,
	)
	const favorite_apps = createBinding(applications, "favorites")
	const all_apps = createBinding(applications, "list")
	let previous_items: dock_item[] = []

	return createComputed((): dock_item[] => {
		const running = is_dock_location() ? running_clients() : []
		const grouped = group_running_clients(running, all_apps())
		const items: dock_item[] = []
		if (shows_favorites(options.favorites.location()))
			items.push(...favorite_items(favorite_apps(), grouped))
		for (const [app_class, clients] of grouped.groups)
			items.push(group_item(app_class, clients, grouped.matched_apps))
		if (options.dock.trash()) {
			if (items.length > 0) items.push({ kind: "separator" })
			items.push({ kind: "trash" })
		}

		const stable_items = items.map((item, index) => {
			const previous = previous_items[index]
			if (previous && same_item(item, previous)) return previous
			return item
		})
		previous_items = stable_items
		return stable_items
	})
}

function DockIconBox({
	side,
	children,
}: {
	side: dock_side
	children: JSX.Element | JSX.Element[]
}) {
	return (
		<box
			class={`dock-icon ${side_class(side)}`}
			orientation={side === "left" ? HORIZONTAL : VERTICAL}
			halign={CENTER}
		>
			{children}
		</box>
	)
}

function GroupedIcon({
	clients,
	app_class,
	icon_name,
	icon_size,
	side,
}: {
	clients: AstalHyprland.Client[]
	app_class: string
	icon_name?: string
	icon_size: Accessor<number>
	side: dock_side
}) {
	const is_focused = focused_window_client.as(
		(current_client) =>
			current_client != null &&
			clients.some((client) => client.address === current_client.address),
	)
	const tooltip_text =
		clients.length === 1
			? clients[0].get_title() || app_class
			: `${app_class} (${clients.length} windows)`

	function window_dots() {
		return (
			<box
				class="window-dots"
				orientation={side === "left" ? VERTICAL : HORIZONTAL}
				halign={CENTER}
				valign={CENTER}
			>
				{Array.from({ length: Math.min(clients.length, 3) }, () => (
					<box
						class={is_focused.as((focused) =>
							focused ? "window-dot focused" : "window-dot",
						)}
						halign={CENTER}
						valign={CENTER}
					/>
				))}
			</box>
		)
	}

	function focus_next() {
		const current_client = focused_window_client.peek()
		const current_index = current_client
			? clients.findIndex((client) => client.address === current_client.address)
			: -1
		void focus_client(clients[(current_index + 1) % clients.length])
	}

	return (
		<DockIconBox side={side}>
			{side === "left" ? window_dots() : <></>}
			<button class="app-button" tooltipText={tooltip_text} canFocus={false}>
				<Gtk.GestureClick
					button={0}
					onPressed={(gesture) => {
						dispatch_client_button_action(gesture.get_current_button(), {
							primary: focus_next,
							secondary: () => focus_client_and_toggle_fullscreen(clients[0]),
							middle: () =>
								clients.forEach((client) => void close_client(client)),
						})
						gesture.reset()
					}}
				/>
				<ApplicationIcon
					icon={client_icon_name(icon_name, app_class)}
					size={icon_size}
				/>
			</button>
			{side === "bottom" ? window_dots() : <></>}
		</DockIconBox>
	)
}

function FavoriteIcon({
	app: favorite,
	icon_size,
	side,
}: {
	app: AstalApps.Application
	icon_size: Accessor<number>
	side: dock_side
}) {
	const [launching, set_launching] = createState(false)
	return (
		<DockIconBox side={side}>
			<button
				class={launching.as((value) =>
					value ? "app-button launching" : "app-button",
				)}
				tooltipText={favorite.get_name()}
				canFocus={false}
				onClicked={() => {
					set_launching(true)
					void launch_app(favorite).then((launched) =>
						log_error(launched, "dock: Could not launch application"),
					)
					timeout(250, () => set_launching(false))
				}}
			>
				<ApplicationIcon icon={favorite.get_icon_name()} size={icon_size} />
			</button>
		</DockIconBox>
	)
}

function TrashIcon({
	icon_size,
	side,
}: {
	icon_size: Accessor<number>
	side: dock_side
}) {
	return (
		<DockIconBox side={side}>
			<button
				class="app-button"
				tooltipText="Trash"
				canFocus={false}
				onClicked={Trash.open_trash}
			>
				<image
					halign={CENTER}
					valign={CENTER}
					iconName={Trash.has_items.as((has_items) =>
						has_items ? icons.trash_detailed.full : icons.trash_detailed.empty,
					)}
					pixelSize={icon_size}
					useFallback
				/>
			</button>
		</DockIconBox>
	)
}

export function render_dock_item(
	item: dock_item,
	side: dock_side,
	icon_size: Accessor<number>,
) {
	switch (item.kind) {
		case "group":
			return (
				<GroupedIcon
					clients={item.clients}
					app_class={item.app_class}
					icon_name={item.icon}
					icon_size={icon_size}
					side={side}
				/>
			)
		case "favorite":
			return <FavoriteIcon app={item.app} icon_size={icon_size} side={side} />
		case "trash":
			return <TrashIcon icon_size={icon_size} side={side} />
		case "separator":
			if (side === "left")
				return <Gtk.Separator class="dock-separator" orientation={HORIZONTAL} />
			return (
				<Gtk.Separator
					class="dock-separator"
					orientation={VERTICAL}
					valign={CENTER}
					heightRequest={icon_size}
				/>
			)
	}
}
