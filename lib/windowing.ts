import {
	type Accessor,
	createBinding,
	createComputed,
	createState,
	onCleanup,
} from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import app from "$lib/app"
import { idle } from "$lib/time"

import AstalHyprland from "gi://AstalHyprland"
import giCairo from "cairo"

import { hyprland, hyprland_command } from "$lib/hyprland"
import { lua_string } from "$lib/lua"
import { err, log_error, ok, type Result } from "$lib/result"

const { BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_MIDDLE } = Gdk

export function toggle_window(name: string | undefined) {
	if (name == undefined) return
	const win = app.get_window(name)
	if (win?.visible) win.hide()
	else win?.show()
}

export function ignore_input(widget: Gtk.Window) {
	widget.get_surface()?.set_input_region(new giCairo.Region())
}

export function on_window_toggle(
	name: string,
	callback: (window: Gtk.Window) => void,
) {
	const handler = app.connect("window-toggled", (_app, window: Gtk.Window) => {
		if (window.name === name) callback(window)
	})

	return () => app.disconnect(handler)
}

export function schedule_monitor_window_release(window?: Gtk.Window | null) {
	if (!window) return
	window.set_visible(false)
	idle(() => window.destroy())
}

export function track_monitor_fullscreen(target: Gdk.Monitor) {
	const [fullscreen, set_fullscreen] = createState(false)

	const find_monitor = () => {
		const connector = target.get_connector()
		const geometry = target.get_geometry()

		return (
			hyprland.monitors.find((monitor) => monitor.name === connector) ??
			hyprland.monitors.find(
				(monitor) => monitor.x === geometry.x && monitor.y === geometry.y,
			)
		)
	}

	const sync = () => {
		const monitor = find_monitor()
		if (!monitor) {
			set_fullscreen(false)
			return
		}

		const special_workspace = monitor.specialWorkspace?.id
		const workspace =
			special_workspace && special_workspace !== 0
				? special_workspace
				: monitor.activeWorkspace?.id

		set_fullscreen(
			typeof workspace === "number" &&
				hyprland.clients.some(
					(client) =>
						client.mapped &&
						!client.hidden &&
						client.monitor?.id === monitor.id &&
						client.workspace?.id === workspace &&
						(client.fullscreen === AstalHyprland.Fullscreen.FULLSCREEN ||
							client.fullscreenClient === AstalHyprland.Fullscreen.FULLSCREEN),
				),
		)
	}

	const event_handler = hyprland.connect("event", sync)
	sync()
	onCleanup(() => hyprland.disconnect(event_handler))
	return fullscreen
}

function filter_valid_window_clients(
	clients: Array<AstalHyprland.Client | null | undefined>,
) {
	return clients.filter((client): client is AstalHyprland.Client => {
		if (!client) return false
		if (client.class !== "") return true
		const title = client.get_title?.() ?? client.title
		return typeof title === "string" && title.length > 0
	})
}

export const focused_window_client = createBinding(hyprland, "focusedClient")

export function create_client_title_accessor(client: AstalHyprland.Client) {
	const title = createBinding(client, "title")
	const class_name = createBinding(client, "class")
	return createComputed(() => {
		if (title()?.length) return title()
		const name = (class_name() || "Unknown").split(".").pop()!
		return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
	})
}

export function get_client_workspace_id(client: AstalHyprland.Client) {
	return client.workspace?.id ?? client.get_workspace?.()?.id ?? null
}

const [client_placement_version, set_client_placement_version] = createState(0)
let placement_tracker_installed = false
let placement_handlers: number[] = []

function install_placement_tracker() {
	if (placement_tracker_installed) return
	placement_tracker_installed = true
	const bump = () =>
		set_client_placement_version(client_placement_version.peek() + 1)
	placement_handlers = [
		hyprland.connect("client-moved", bump),
		hyprland.connect("client-added", bump),
		hyprland.connect("client-removed", bump),
	]
}

app.connect("shutdown", () => {
	for (const handler of placement_handlers) hyprland.disconnect(handler)
	placement_handlers = []
	placement_tracker_installed = false
})

export function refresh_client_placement() {
	install_placement_tracker()
	set_client_placement_version(client_placement_version.peek() + 1)
}

export function read_client_placement_version() {
	return client_placement_version()
}

export function subscribe_client_placement(callback: () => void) {
	return client_placement_version.subscribe(callback)
}

export function create_workspace_clients(workspace_id: number) {
	install_placement_tracker()
	const clients = createBinding(hyprland, "clients")
	return createComputed(() => {
		client_placement_version()
		return filter_valid_window_clients(clients() ?? []).filter(
			(client) => get_client_workspace_id(client) === workspace_id,
		)
	})
}

function sort_by_workspace(clients: AstalHyprland.Client[]) {
	return [...clients].sort((a, b) => {
		return (get_client_workspace_id(a) ?? 0) - (get_client_workspace_id(b) ?? 0)
	})
}

function filter_window_clients_for_workspace(
	clients: AstalHyprland.Client[],
	focused_workspace_id: number | null | undefined,
	is_exclusive: boolean,
) {
	if (!is_exclusive || focused_workspace_id == null) return clients
	return clients.filter(
		(client) => get_client_workspace_id(client) === focused_workspace_id,
	)
}

type client_reference = AstalHyprland.Client | string | null | undefined

function client_window(client: client_reference): Result<string> {
	const raw =
		typeof client === "string"
			? client
			: (client?.get_address?.() ?? client?.address)
	const address = String(raw ?? "").trim()
	if (!address) return err(new Error("Client has no address"))
	return ok(
		lua_string(
			`address:${address.startsWith("0x") ? address : `0x${address}`}`,
		),
	)
}

async function dispatch_to_client(
	client: client_reference,
	dispatcher: (window: string) => string,
	context: string,
): Promise<Result<void>> {
	const window = client_window(client)
	const result = window.ok
		? await hyprland_command(`dispatch ${dispatcher(window.value)}`)
		: window
	log_error(result, context)
	return result
}

export function focus_client(client: client_reference) {
	return dispatch_to_client(
		client,
		(window) => `hl.dsp.focus({ window = ${window} })`,
		"windowing.focus: Failed to focus client",
	)
}

export function close_client(client: client_reference) {
	return dispatch_to_client(
		client,
		(window) => `hl.dsp.window.close({ window = ${window} })`,
		"windowing.close: Failed to close client",
	)
}

export async function focus_client_and_toggle_fullscreen(
	client: AstalHyprland.Client,
): Promise<Result<void>> {
	const focused = await focus_client(client)
	if (!focused.ok) return focused
	return dispatch_to_client(
		client,
		(window) => `hl.dsp.window.fullscreen({ window = ${window} })`,
		"windowing.fullscreen: Failed to toggle fullscreen",
	)
}

export function move_client_to_workspace_silent(
	workspace_id: number,
	client: client_reference,
): Promise<Result<void>> {
	return dispatch_to_client(
		client,
		(window) =>
			`hl.dsp.window.move({ workspace = ${workspace_id}, follow = false, window = ${window} })`,
		"windowing.move: Failed to move client",
	)
}

export function dispatch_client_button_action(
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

export function create_window_client_list(
	exclusive_workspace: Accessor<boolean>,
) {
	install_placement_tracker()
	const clients = createBinding(hyprland, "clients")
	const focused_workspace_id = createBinding(hyprland, "focusedWorkspace").as(
		(workspace) => workspace?.id ?? null,
	)

	return createComputed(() => {
		client_placement_version()
		return filter_window_clients_for_workspace(
			sort_by_workspace(filter_valid_window_clients(clients() ?? [])),
			focused_workspace_id(),
			exclusive_workspace(),
		)
	})
}
