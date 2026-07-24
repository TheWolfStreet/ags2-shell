// Lists open windows and handles focus, close, move, and workspace actions.

import { createBinding, createComputed } from "ags"
import { Gdk } from "ags/gtk4"

import AstalHyprland from "gi://AstalHyprland"

import { hyprland } from "$service/system"

import options from "options"

const { BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_MIDDLE } = Gdk

export function normalizeTaskClients(clients: Array<AstalHyprland.Client | null | undefined>) {
	return clients.filter((client): client is AstalHyprland.Client => {
		return !!client && client.class !== ""
	})
}

export const focusedClient = createBinding(hyprland, "focusedClient")

export function getClientWorkspaceId(client: AstalHyprland.Client) {
	return client.workspace?.id ?? client.get_workspace?.()?.id ?? null
}

function sortByWorkspace(clients: AstalHyprland.Client[]) {
	return [...clients].sort((a, b) => {
		return (getClientWorkspaceId(a) ?? 0) - (getClientWorkspaceId(b) ?? 0)
	})
}

function filterClientsForTasks(
	clients: AstalHyprland.Client[],
	focusedWorkspaceId: number | null | undefined,
	isExclusive: boolean,
) {
	if (!isExclusive || focusedWorkspaceId == null) return clients
	return clients.filter(client => getClientWorkspaceId(client) === focusedWorkspaceId)
}

export function focusClientFullscreen(client: AstalHyprland.Client) {
	client.focus()
	hyprland.message("dispatch fullscreen")
}

function normalizeClientAddress(value: string | null | undefined) {
	if (!value)
		return null

	const raw = String(value).trim()
	if (!raw)
		return null

	return raw.startsWith("0x") ? raw : `0x${raw}`
}

export function moveClientToWorkspaceSilent(
	workspaceId: number,
	clientOrAddress: AstalHyprland.Client | string | null | undefined,
) {
	const rawAddress = typeof clientOrAddress === "string"
		? clientOrAddress
		: clientOrAddress?.get_address?.() ?? clientOrAddress?.address

	const address = normalizeClientAddress(rawAddress)
	if (!address)
		return

	hyprland.message_async(`dispatch movetoworkspacesilent ${workspaceId},address:${address}`, null)
}

export function onClientClick(
	button: number,
	actions: {
		primary: () => void
		secondary: () => void
		middle: () => void
	},
) {
	if (button === BUTTON_PRIMARY) actions.primary()
	if (button === BUTTON_SECONDARY) actions.secondary()
	if (button === BUTTON_MIDDLE) actions.middle()
}

export function createTaskItems() {
	const clients = createBinding(hyprland, "clients").as(clients => {
		return sortByWorkspace(normalizeTaskClients(clients ?? []))
	})

	const focusedWorkspaceId = createBinding(hyprland, "focusedWorkspace").as(workspace => workspace?.id ?? null)

	return createComputed(() =>
		filterClientsForTasks(clients(), focusedWorkspaceId(), options.bar.taskbar.exclusive())
	)
}
