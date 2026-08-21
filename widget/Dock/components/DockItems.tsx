// Projects and renders dock items for windows, applications, and trash.

import { Accessor, createBinding, createComputed, createState } from "ags"
import { Gtk } from "ags/gtk4"
import { timeout } from "ags/time"

import AstalApps from "gi://AstalApps"
import AstalHyprland from "gi://AstalHyprland"

import icons from "$lib/icons"
import {
	createWindowClientList,
	dispatchClientButtonAction,
	filterValidWindowClients,
	focusedWindowClient,
	focusClientAndToggleFullscreen,
} from "$lib/windowing"
import { applications, launchApp } from "$service/apps"
import { hyprland } from "$service/astal"
import options from "$shell/options"
import { ApplicationIcon } from "widget/shared/ApplicationIcon"

import * as Trash from "./Trash"

export type DockSide = "left" | "bottom"

type DockItem =
	| {
			kind: "group"
			clients: AstalHyprland.Client[]
			appClass: string
			icon?: string
	  }
	| { kind: "favorite"; app: AstalApps.Application }
	| { kind: "separator" }
	| { kind: "trash" }

const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { CENTER } = Gtk.Align

const GENERIC_MATCH_TOKENS = new Set([
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

function lookupTokens(value: string | null | undefined) {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) return []

	const tokens = new Set<string>([normalized])
	for (const token of normalized.split(/[ .:_-]+/g)) {
		if (token.length >= 3 && !GENERIC_MATCH_TOKENS.has(token)) tokens.add(token)
	}
	return [...tokens]
}

function favoriteKeys(favorite: AstalApps.Application) {
	return [
		...new Set([
			...lookupTokens(favorite.get_name()),
			...lookupTokens(favorite.get_executable()),
			...lookupTokens(favorite.get_entry()),
		]),
	]
}

export function createDockItems(isDockLocation: Accessor<boolean>) {
	const runningClients = createWindowClientList(options.bar.taskbar.exclusive)
	const favoriteApps = createBinding(applications, "favorites")

	return createComputed((): DockItem[] => {
		const running = isDockLocation() ? runningClients() : []
		const groups = new Map<string, AstalHyprland.Client[]>()
		for (const client of running) {
			const appClass = client.get_class()
			const group = groups.get(appClass)
			if (group) group.push(client)
			else groups.set(appClass, [client])
		}

		const items: DockItem[] = []
		const favoriteLocation = options.favorites.location()

		if (favoriteLocation === "dock" || favoriteLocation === "both") {
			for (const favorite of favoriteApps()) {
				const keys = favoriteKeys(favorite)
				const appClass = [...groups.keys()].find((candidate) =>
					lookupTokens(candidate).some((token) => keys.includes(token)),
				)

				if (appClass == null) {
					items.push({ kind: "favorite", app: favorite })
					continue
				}

				items.push({
					kind: "group",
					clients: groups.get(appClass)!,
					appClass,
					icon: favorite.get_icon_name() || undefined,
				})
				groups.delete(appClass)
			}
		}

		for (const [appClass, clients] of groups)
			items.push({ kind: "group", clients, appClass })

		if (options.dock.trash()) {
			if (items.length > 0) items.push({ kind: "separator" })
			items.push({ kind: "trash" })
		}

		return items
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
	appClass,
	iconName,
	iconSize,
	side,
}: {
	clients: AstalHyprland.Client[]
	appClass: string
	iconName?: string
	iconSize: Accessor<number>
	side: DockSide
}) {
	const isFocused = focusedWindowClient.as(
		(currentClient) =>
			currentClient != null &&
			clients.some((client) => client.address === currentClient.address),
	)
	const tooltipText =
		clients.length === 1
			? clients[0].get_title() || appClass
			: `${appClass} (${clients.length} windows)`

	function makeDots() {
		return Array.from({ length: Math.min(clients.length, 3) }, () => (
			<box
				class={isFocused.as((focused) =>
					focused ? "window-dot focused" : "window-dot",
				)}
				halign={CENTER}
				valign={CENTER}
			/>
		))
	}

	function focusNext() {
		const currentClient = focusedWindowClient.peek()
		const index = currentClient
			? clients.findIndex((client) => client.address === currentClient.address)
			: -1
		clients[index >= 0 ? (index + 1) % clients.length : 0].focus()
	}

	return (
		<DockIconBox side={side}>
			<box
				class="window-dots"
				orientation={VERTICAL}
				halign={CENTER}
				valign={CENTER}
				visible={side === "left"}
			>
				{makeDots()}
			</box>
			<button class="app-button" tooltipText={tooltipText} canFocus={false}>
				<Gtk.GestureClick
					button={0}
					onPressed={(gesture) => {
						dispatchClientButtonAction(gesture.get_current_button(), {
							primary: focusNext,
							secondary: () => focusClientAndToggleFullscreen(clients[0]),
							middle: () => clients.forEach((client) => client.kill()),
						})
						gesture.reset()
					}}
				/>
				<ApplicationIcon icon={iconName || appClass} size={iconSize} />
			</button>
			<box
				class="window-dots"
				orientation={HORIZONTAL}
				halign={CENTER}
				valign={CENTER}
				visible={side === "bottom"}
			>
				{makeDots()}
			</box>
		</DockIconBox>
	)
}

function FavoriteIcon({
	app: favorite,
	iconSize,
	side,
}: {
	app: AstalApps.Application
	iconSize: Accessor<number>
	side: DockSide
}) {
	const [launching, setLaunching] = createState(false)
	return (
		<DockIconBox side={side}>
			<button
				class={launching.as((value) =>
					value ? "app-button launching" : "app-button",
				)}
				tooltipText={favorite.get_name()}
				canFocus={false}
				onClicked={() => {
					setLaunching(true)
					launchApp(favorite)
					timeout(250, () => setLaunching(false))
				}}
			>
				<ApplicationIcon icon={favorite.get_icon_name()} size={iconSize} />
			</button>
		</DockIconBox>
	)
}

function TrashIcon({
	iconSize,
	side,
}: {
	iconSize: Accessor<number>
	side: DockSide
}) {
	return (
		<DockIconBox side={side}>
			<button
				class="app-button"
				tooltipText="Trash"
				canFocus={false}
				onClicked={() =>
					Trash.openOrFocus(
						filterValidWindowClients(hyprland.clients ?? []),
						hyprland.focusedWorkspace?.id ?? null,
					)
				}
			>
				<image
					halign={CENTER}
					valign={CENTER}
					iconName={Trash.hasItems.as((hasItems) =>
						hasItems ? icons.trashDetailed.full : icons.trashDetailed.empty,
					)}
					pixelSize={iconSize}
					useFallback
				/>
			</button>
		</DockIconBox>
	)
}

export function renderDockItem(
	item: DockItem,
	side: DockSide,
	iconSize: Accessor<number>,
) {
	switch (item.kind) {
		case "group":
			return (
				<GroupedIcon
					clients={item.clients}
					appClass={item.appClass}
					iconName={item.icon}
					iconSize={iconSize}
					side={side}
				/>
			)
		case "favorite":
			return <FavoriteIcon app={item.app} iconSize={iconSize} side={side} />
		case "trash":
			return <TrashIcon iconSize={iconSize} side={side} />
		case "separator":
			return side === "left" ? (
				<Gtk.Separator class="dock-separator" orientation={HORIZONTAL} />
			) : (
				<Gtk.Separator
					class="dock-separator"
					orientation={VERTICAL}
					valign={CENTER}
					heightRequest={iconSize}
				/>
			)
	}
}
