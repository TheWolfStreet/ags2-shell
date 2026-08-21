// Handles shared window controls, monitor state, and Hyprland client actions.

import { type Accessor, createBinding, createComputed, createState, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { idle } from "ags/time"

import AstalHyprland from "gi://AstalHyprland"
import giCairo from "cairo"

import { hyprland } from "$service/astal"

const { BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_MIDDLE } = Gdk

export function toggleWindow(name: string | undefined, hide: boolean = true) {
	if (name == undefined) return
	const win = app.get_window(name)
	if (win?.visible) {
		if (hide)
			win.hide()
		else
			win.close()
	} else {
		win?.show()
	}
}

export function ignoreInput(widget: Gtk.Window) {
	widget.get_surface()?.set_input_region(new giCairo.Region)
}

export function onWindowToggle(name: string, callback: (window: Gtk.Window) => void) {
	const handler = app.connect("window-toggled", (_, window: Gtk.Window) => {
		if (window.name === name)
			callback(window)
	})

	return () => app.disconnect(handler)
}

// GTK 4.22 crashes when destroying an unmapped application window. Hide it instead;
// windows with a surface must still be destroyed so they cannot be re-anchored.
export function scheduleMonitorWindowRelease(window?: Gtk.Window | null) {
	if (!window) return
	idle(() => {
		if (window.get_application() && !window.get_surface())
			window.set_visible(false)
		else
			window.destroy()
	})
}

export function basicMonitorKey(monitor: Gdk.Monitor, fallback: string): string {
	return monitor.get_connector() ?? fallback
}

export function trackMonitorFullscreen(target: Gdk.Monitor) {
	const [fullscreen, setFullscreen] = createState(false)

	const findMonitor = () => {
		const connector = target.get_connector()
		const geometry = target.get_geometry()

		return hyprland.monitors.find(monitor => monitor.name === connector)
			?? hyprland.monitors.find(monitor => monitor.x === geometry.x && monitor.y === geometry.y)
	}

	const sync = () => {
		const monitor = findMonitor()
		if (!monitor) {
			setFullscreen(false)
			return
		}

		const specialWorkspace = monitor.specialWorkspace?.id
		const workspace = specialWorkspace && specialWorkspace !== 0
			? specialWorkspace
			: monitor.activeWorkspace?.id

		setFullscreen(typeof workspace === "number" && hyprland.clients.some(client =>
			client.mapped
			&& !client.hidden
			&& client.monitor?.id === monitor.id
			&& client.workspace?.id === workspace
			&& (client.fullscreen === AstalHyprland.Fullscreen.FULLSCREEN
				|| client.fullscreenClient === AstalHyprland.Fullscreen.FULLSCREEN),
		))
	}

	const eventHandler = hyprland.connect("event", sync)
	sync()
	onCleanup(() => hyprland.disconnect(eventHandler))
	return fullscreen
}

export function filterValidWindowClients(clients: Array<AstalHyprland.Client | null | undefined>) {
	return clients.filter((client): client is AstalHyprland.Client => {
		return !!client && client.class !== ""
	})
}

export const focusedWindowClient = createBinding(hyprland, "focusedClient")

export function createClientTitleAccessor(client: AstalHyprland.Client) {
	const title = createBinding(client, "title")
	const className = createBinding(client, "class")
	return createComputed(() => {
		if (title()?.length) return title()
		const name = (className() || "Unknown").split(".").pop()!
		return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
	})
}

export function getClientWorkspaceId(client: AstalHyprland.Client) {
	return client.workspace?.id ?? client.get_workspace?.()?.id ?? null
}

function sortByWorkspace(clients: AstalHyprland.Client[]) {
	return [...clients].sort((a, b) => {
		return (getClientWorkspaceId(a) ?? 0) - (getClientWorkspaceId(b) ?? 0)
	})
}

function filterWindowClientsForWorkspace(
	clients: AstalHyprland.Client[],
	focusedWorkspaceId: number | null | undefined,
	isExclusive: boolean,
) {
	if (!isExclusive || focusedWorkspaceId == null) return clients
	return clients.filter(client => getClientWorkspaceId(client) === focusedWorkspaceId)
}

export function focusClientAndToggleFullscreen(client: AstalHyprland.Client) {
	client.focus()
	hyprland.message("dispatch fullscreen")
}

function normalizeClientAddress(value: string | null | undefined) {
	if (!value) return null

	const raw = String(value).trim()
	if (!raw) return null
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
	if (!address) return
	hyprland.message_async(`dispatch movetoworkspacesilent ${workspaceId},address:${address}`, null)
}

export function dispatchClientButtonAction(
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

export function createWindowClientList(exclusiveWorkspace: Accessor<boolean>) {
	const clients = createBinding(hyprland, "clients").as(clients => {
		return sortByWorkspace(filterValidWindowClients(clients ?? []))
	})
	const focusedWorkspaceId = createBinding(hyprland, "focusedWorkspace").as(workspace => workspace?.id ?? null)

	return createComputed(() =>
		filterWindowClientsForWorkspace(clients(), focusedWorkspaceId(), exclusiveWorkspace())
	)
}
