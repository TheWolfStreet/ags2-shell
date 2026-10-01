import { Accessor, createBinding, createComputed, createState } from "ags"
import { Gtk } from "ags/gtk4"
import { timeout } from "$lib/time"

import AstalApps from "gi://AstalApps"
import AstalHyprland from "gi://AstalHyprland"

import icons from "$lib/icons"
import {
	create_window_client_list,
	dispatch_client_button_action,
	focused_window_client,
	focus_client_and_toggle_fullscreen,
} from "$lib/windowing"
import { launch_app } from "$lib/apps"
import { applications } from "$service/apps"
import options from "$shell/options"
import { ApplicationIcon } from "widget/shared/ApplicationIcon"

import * as Trash from "./Trash"

export type DockSide = "left" | "bottom"

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

const generic_match_tokens = new Set([
	"app",
	"apps",
	"application",
	"bin",
	"com",
	"desktop",
	"exe",
	"flatpak",
	"io",
	"linux",
	"local",
	"net",
	"opt",
	"org",
	"snap",
	"usr",
])

function lookup_tokens(value: string | null | undefined) {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) return []

	const tokens = new Set<string>([normalized])
	for (const token of normalized.split(/[ .:_-]+/g)) {
		if (token.length >= 3 && !generic_match_tokens.has(token)) tokens.add(token)
	}
	return [...tokens]
}

export function create_dock_items(is_dock_location: Accessor<boolean>) {
	const running_clients = create_window_client_list(options.bar.taskbar.exclusive)
	const favorite_apps = createBinding(applications, "favorites")
	const all_apps = createBinding(applications, "list")
	let previous_items: dock_item[] = []

	return createComputed((): dock_item[] => {
		const running = is_dock_location() ? running_clients() : []
		const groups = new Map<string, AstalHyprland.Client[]>()
		for (const client of running) {
			const app_class = client.get_class()
			const group = groups.get(app_class)
			if (group) group.push(client)
			else groups.set(app_class, [client])
		}
		const app_for_class = (app_class: string) => {
			const exact = all_apps().find((app) =>
				app.get_wm_class()?.toLowerCase() === app_class.toLowerCase() ||
				app.get_entry()?.replace(/\.desktop$/i, "").toLowerCase() === app_class.toLowerCase())
			if (exact) return exact
			const class_tokens = new Set(lookup_tokens(app_class))
			return all_apps().find((app) => {
				const app_tokens = [
					...lookup_tokens(app.get_wm_class()),
					...lookup_tokens(app.get_name()),
					...lookup_tokens(app.get_executable()),
					...lookup_tokens(app.get_entry()),
				]
				return app_tokens.some((token) => class_tokens.has(token))
			})
		}

		const items: dock_item[] = []
		const favorite_location = options.favorites.location()

		if (favorite_location === "dock" || favorite_location === "both") {
			for (const favorite of favorite_apps()) {
				const exact_class = [...groups.keys()].find((app_class) =>
					favorite.get_wm_class()?.toLowerCase() === app_class.toLowerCase() ||
					favorite.get_entry()?.replace(/\.desktop$/i, "").toLowerCase() === app_class.toLowerCase())
				const favorite_tokens = new Set([
				...lookup_tokens(favorite.get_wm_class()),
					...lookup_tokens(favorite.get_name()),
					...lookup_tokens(favorite.get_executable()),
					...lookup_tokens(favorite.get_entry()),
				])
				const matching_group = exact_class
					? [exact_class, groups.get(exact_class)!] as const
					: [...groups].find(([app_class]) =>
						lookup_tokens(app_class).some((token) => favorite_tokens.has(token)))
				if (!matching_group) {
					items.push({ kind: "favorite", app: favorite })
					continue
				}

				const [app_class, clients] = matching_group
				items.push({
					kind: "group",
					clients,
					app_class: app_class,
					icon: favorite.get_icon_name() || undefined,
				})
				groups.delete(app_class)
			}
		}

		for (const [app_class, clients] of groups)
			items.push({
				kind: "group",
				clients,
				app_class: app_class,
				icon: app_for_class(app_class)?.get_icon_name() || undefined,
			})

		if (options.dock.trash()) {
			if (items.length > 0) items.push({ kind: "separator" })
			items.push({ kind: "trash" })
		}

		const stable_items = items.map((item, index) => {
			const previous = previous_items[index]
			if (!previous || previous.kind !== item.kind) return item
			if (item.kind === "group" && previous.kind === "group" &&
				item.app_class === previous.app_class && item.icon === previous.icon &&
				item.clients.length === previous.clients.length &&
				item.clients.every((client, i) => client === previous.clients[i])) return previous
			if (item.kind === "favorite" && previous.kind === "favorite" && item.app === previous.app)
				return previous
			if (item.kind === "separator" || item.kind === "trash") return previous
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
	side: DockSide
	children: JSX.Element | JSX.Element[]
}) {
	return (
		<box
			class={`dock-icon ${side === "left" ? "dock-vertical" : "dock-horizontal"}`}
			orientation={side === "left" ? HORIZONTAL : VERTICAL}
			halign={CENTER}
		>
			{children}
		</box>
	)
}

function GroupedIcon({
	clients,
	app_class: app_class,
	icon_name: icon_name,
	icon_size: icon_size,
	side,
}: {
	clients: AstalHyprland.Client[]
	app_class: string
	icon_name?: string
	icon_size: Accessor<number>
	side: DockSide
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

	function make_dots() {
		return Array.from({ length: Math.min(clients.length, 3) }, () => (
			<box
				class={is_focused.as((focused) =>
					focused ? "window-dot focused" : "window-dot",
				)}
				halign={CENTER}
				valign={CENTER}
			/>
		))
	}

	function focus_next() {
		const current_client = focused_window_client.peek()
		let next_index = 0
		if (current_client) {
			const current_index = clients.findIndex(
				(client) => client.address === current_client.address,
			)
			if (current_index >= 0) next_index = (current_index + 1) % clients.length
		}
		clients[next_index].focus()
	}

	return (
		<DockIconBox side={side}>
			{side === "left" ? <box class="window-dots" orientation={VERTICAL}
				halign={CENTER} valign={CENTER}>{make_dots()}</box> : <></>}
			<button class="app-button" tooltipText={tooltip_text} canFocus={false}>
				<Gtk.GestureClick
					button={0}
					onPressed={(gesture) => {
						dispatch_client_button_action(gesture.get_current_button(), {
							primary: focus_next,
							secondary: () => focus_client_and_toggle_fullscreen(clients[0]),
							middle: () => clients.forEach((client) => client.kill()),
						})
						gesture.reset()
					}}
				/>
				<ApplicationIcon icon={icon_name || app_class} size={icon_size} />
			</button>
			{side === "bottom" ? <box class="window-dots" orientation={HORIZONTAL}
				halign={CENTER} valign={CENTER}>{make_dots()}</box> : <></>}
		</DockIconBox>
	)
}

function FavoriteIcon({
	app: favorite,
	icon_size: icon_size,
	side,
}: {
	app: AstalApps.Application
	icon_size: Accessor<number>
	side: DockSide
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
					void launch_app(favorite).then(result => {
						if (!result.ok) console.error("dock: Could not launch application", result.err)
					})
					timeout(250, () => set_launching(false))
				}}
			>
				<ApplicationIcon icon={favorite.get_icon_name()} size={icon_size} />
			</button>
		</DockIconBox>
	)
}

function TrashIcon({
	icon_size: icon_size,
	side,
}: {
	icon_size: Accessor<number>
	side: DockSide
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
	side: DockSide,
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
