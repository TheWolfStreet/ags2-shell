// Lists running applications, favorites, separators, and trash in the dock.

import { Accessor, createBinding, createComputed } from "ags"

import AstalApps from "gi://AstalApps"
import AstalHyprland from "gi://AstalHyprland"

import { apps } from "$service/apps"
import { createTaskItems } from "$lib/tasks"

import options from "options"

export type Side = "left" | "bottom"

export type DockItem =
	| { kind: "group", clients: AstalHyprland.Client[], appClass: string, icon?: string }
	| { kind: "favorite", app: AstalApps.Application }
	| { kind: "separator" }
	| { kind: "trash" }

export const isLeftPosition = (pos: string) => pos === "center-left"
export const isOnLeft = options.dock.position.as(isLeftPosition)

const GENERIC_MATCH_TOKENS = new Set([
	"app", "apps", "application",
	"bin", "com", "desktop", "exe",
	"flatpak", "io", "linux", "local",
	"net", "opt", "org", "snap", "usr",
])

function lookupTokens(value: string | null | undefined) {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) return []

	const tokens = new Set<string>([normalized])
	for (const token of normalized.split(/[ .:_-]+/g)) {
		if (token.length >= 3 && !GENERIC_MATCH_TOKENS.has(token))
			tokens.add(token)
	}
	return [...tokens]
}

function favoriteKeys(fav: AstalApps.Application) {
	const keys = [
		...lookupTokens(fav.get_name()),
		...lookupTokens(fav.get_executable()),
		...lookupTokens(fav.get_entry()),
	]
	return [...new Set(keys)]
}

export function createDockItems(isDockLocation: Accessor<boolean>) {
	const runningClients = createTaskItems()
	const favoriteApps = createBinding(apps, "favorites")
	const showTrash = options.dock.trash

	return createComputed((): DockItem[] => {
		const running = isDockLocation() ? runningClients() : []
		const classes = running.map(c => c.get_class())

		const groups = new Map<string, AstalHyprland.Client[]>()
		for (let i = 0; i < running.length; i++) {
			const cls = classes[i]
			const group = groups.get(cls)
			if (group) group.push(running[i])
			else groups.set(cls, [running[i]])
		}

		const favLocation = options.favorites.location()
		const showFavorites = favLocation === "dock" || favLocation === "both"
		const claimed = new Set<string>()
		const items: DockItem[] = []

		if (showFavorites) {
			for (const fav of favoriteApps()) {
				const keys = favoriteKeys(fav)
				const runningClass = [...groups.keys()].find(cls =>
					!claimed.has(cls) && lookupTokens(cls).some(token => keys.includes(token)))

				if (runningClass) {
					claimed.add(runningClass)
					items.push({ kind: "group", clients: groups.get(runningClass)!, appClass: runningClass, icon: fav.get_icon_name() || undefined })
				} else {
					items.push({ kind: "favorite", app: fav })
				}
			}
		}

		for (const [appClass, clients] of groups) {
			if (!claimed.has(appClass))
				items.push({ kind: "group", clients, appClass })
		}

		if (showTrash()) {
			if (items.length > 0) items.push({ kind: "separator" })
			items.push({ kind: "trash" })
		}

		return items
	})
}
