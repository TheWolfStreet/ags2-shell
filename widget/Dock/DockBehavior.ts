// Builds dock items, sizing, orientation, and delayed pointer state.

import { Accessor, createBinding, createComputed, createState } from "ags"
import { Gdk } from "ags/gtk4"
import { timeout, Timer } from "ags/time"

import AstalApps from "gi://AstalApps"
import AstalHyprland from "gi://AstalHyprland"

import { applications } from "$service/applications"
import { createWindowClientList } from "widget/Windowing/WindowClients"

import options from "options"

export type DockSide = "left" | "bottom"

export type DockItem =
	| { kind: "group", clients: AstalHyprland.Client[], appClass: string, icon?: string }
	| { kind: "favorite", app: AstalApps.Application }
	| { kind: "separator" }
	| { kind: "trash" }

export const isLeftDockPosition = (position: string) => position === "center-left"
export const isDockOnLeft = options.dock.position.as(isLeftDockPosition)

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
	const runningClients = createWindowClientList()
	const favoriteApps = createBinding(applications, "favorites")
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

export function createDockSizing(dockItems: Accessor<DockItem[]>, geometry: Accessor<Gdk.Rectangle>) {
	const { mode, position, scale } = options.dock
	const globalScale = options.scale

	const dockScale = createComputed(() => {
		const baseScale = globalScale() / 100
		const userScale = scale() / 100
		const count = dockItems().length
		if (count === 0) return userScale
		const monitorGeometry = geometry()
		const availableLength = isDockOnLeft() ? monitorGeometry.height : monitorGeometry.width
		const maxScale = (availableLength * 0.88 - 2 - count * 11 * baseScale) / (count * 64 * baseScale)
		return Math.max(0.3, Math.min(userScale, maxScale))
	})

	const pixelScale = createComputed(() => dockScale() * (globalScale() / 100))

	return {
		hotzoneThickness: createComputed(() => Math.max(16, Math.round(22 * pixelScale()))),
		windowThickness: createComputed(() => Math.max(48, Math.round(94 * pixelScale()))),
		edgeMargin: createComputed(() => Math.round(16 * pixelScale())),
		iconSize: createComputed(() => Math.max(16, Math.round(64 * pixelScale()))),
		dockScale,
		dockClassName: createComputed(() =>
			`dock-container ${isLeftDockPosition(position()) ? "dock-vertical" : "dock-horizontal"} ${position()} dock-${mode()}`),
	}
}

const HIDE_DELAY_MS = 250

export type DockHoverTracker = ReturnType<typeof createDockHoverTracker>

export function createDockHoverTracker(delayMs = HIDE_DELAY_MS) {
	const [hovered, setHovered] = createState(false)
	const zones = new Set<string>()
	let hideTimer: Timer | undefined

	const cancelHide = () => {
		hideTimer?.cancel()
		hideTimer = undefined
	}

	const scheduleHide = () => {
		cancelHide()
		hideTimer = timeout(delayMs, () => setHovered(false))
	}

	return {
		hovered,
		enter: (zone: string) => {
			zones.add(zone)
			cancelHide()
			if (!hovered())
				setHovered(true)
		},
		leave: (zone: string) => {
			zones.delete(zone)
			if (zones.size === 0)
				scheduleHide()
		},
		dispose: () => {
			zones.clear()
			cancelHide()
		},
	}
}
