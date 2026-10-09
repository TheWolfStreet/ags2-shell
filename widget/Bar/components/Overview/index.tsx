import { createBinding, createComputed, For, onCleanup, onMount } from "ags"
import { idle, timeout, type Timer } from "$lib/time"
import app from "$lib/app"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import AstalHyprland from "gi://AstalHyprland"

import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "../PanelButton"

import { hyprland } from "$lib/hyprland"
import {
	create_client_title_accessor,
	create_workspace_clients,
	focused_window_client,
	move_client_to_workspace_silent,
	on_window_toggle,
	read_client_placement_version,
	refresh_client_placement,
	subscribe_client_placement,
} from "$lib/windowing"

import options from "$shell/options"

export namespace Overview {
	export function Button() {
		const workspaces = createComputed(() =>
			workspace_ids(options.bar.workspaces.count()),
		)
		const class_name = (workspace_id: number) => {
			const occupants = create_workspace_clients(workspace_id)
			const focused = createBinding(hyprland, "focusedWorkspace")
			return createComputed(() => {
				const classes: string[] = []
				if (focused()?.id === workspace_id) classes.push("active")
				if (occupants().length > 0) classes.push("occupied")
				return classes.join(" ")
			})
		}

		return (
			<PanelButton targetWindow="overview" class="workspaces">
				<box valign={CENTER}>
					<For each={workspaces}>
						{(workspace_id) => {
							return (
								<label
									valign={CENTER}
									name={`${workspace_id}`}
									label={`${workspace_id}`}
									class={class_name(workspace_id)}
								/>
							)
						}}
					</For>
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		const existing = app.get_window("overview")
		if (existing) return existing
		const workspaces = createComputed(() =>
			workspace_ids(options.overview.workspaces()),
		)

		let sync_timer: Timer | null = null
		let generation = 0
		let in_flight = false
		let visible = false
		let previous_snapshot = ""
		let sync_warned = false
		const schedule_sync = () => {
			if (!visible || sync_timer) return
			const current_generation = generation
			sync_timer = timeout(overview_sync_interval_ms, () => {
				sync_timer = null
				if (!visible || current_generation !== generation) return
				if (in_flight) schedule_sync()
				else sync_now()
			})
		}
		const stop_sync = () => {
			visible = false
			generation++
			sync_timer?.cancel()
			sync_timer = null
		}
		const sync_now = () => {
			if (in_flight) return
			in_flight = true
			const current_generation = generation
			hyprland.sync_clients((_source, result) => {
				let succeeded = false
				try {
					hyprland.sync_clients_finish(result)
					succeeded = true
				} catch {
					if (!sync_warned)
						console.warn("overview: Hyprland client sync failed")
					sync_warned = true
				}
				in_flight = false
				if (current_generation !== generation) {
					schedule_sync()
					return
				}
				if (succeeded) {
					sync_warned = false
					const snapshot = hyprland.clients
						.map((client) =>
							[
								client.address,
								client.workspace?.id,
								client.x,
								client.y,
								client.width,
								client.height,
							].join(":"),
						)
						.sort()
						.join("|")
					if (snapshot !== previous_snapshot) {
						previous_snapshot = snapshot
						refresh_client_placement()
					}
				}
				schedule_sync()
			})
		}
		const start_sync = () => {
			stop_sync()
			visible = true
			if (in_flight) schedule_sync()
			else sync_now()
		}
		const stop_window_subscription = on_window_toggle("overview", (window) => {
			if (window.visible) start_sync()
			else stop_sync()
		})
		onCleanup(() => {
			stop_window_subscription()
			stop_sync()
		})

		return (
			<PopupWindow application={app} name="overview" layer={OVERLAY}>
				<box class="overview horizontal">
					<For each={workspaces}>
						{(workspace_id) => <Workspace entry={workspace_id} />}
					</For>
				</box>
			</PopupWindow>
		)
	}

	type client_props = {
		entry: AstalHyprland.Client
		update: (self: Gtk.Widget) => void
	}

	const client_update_signals = [
		"notify::x",
		"notify::y",
		"notify::width",
		"notify::height",
		"notify::monitor",
		"notify::workspace",
	] as const

	function sanitize_overview_scale(value: number) {
		return Math.max(1, value)
	}

	function sanitize_dimension(
		value: number | null | undefined,
		fallback: number,
	) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			return fallback
		}

		return value
	}

	function scale_factor(value: number) {
		const safe_value = sanitize_overview_scale(value)
		if (safe_value <= 15) {
			return safe_value / 100
		}
		return ((safe_value / 100) * 9) / 100
	}

	function scale(size: number) {
		return scale_factor(options.overview.scale()) * size
	}

	function workspace_ids(total: number) {
		if (total > 0)
			return Array.from(
				{ length: Math.min(16, total) },
				(_value, index) => index + 1,
			)
		const workspaces = createBinding(hyprland, "workspaces")() ?? []
		const ids = workspaces
			.map((workspace) => workspace.id)
			.filter((id) => id > 0)
		return [...new Set(ids)].sort((a, b) => a - b)
	}

	function workspace_monitor(workspace_id: number) {
		return (
			hyprland.get_workspace(workspace_id)?.get_monitor() ??
			hyprland.get_focused_monitor() ??
			hyprland.monitors[0] ??
			null
		)
	}

	function monitor_size(monitor: AstalHyprland.Monitor | null) {
		if (!monitor)
			return { width: fallback_monitor_width, height: fallback_monitor_height }
		const transform = createBinding(monitor, "transform")()
		const rotated = [1, 3, 5, 7].includes(transform)
		const scale = sanitize_dimension(createBinding(monitor, "scale")(), 1)
		const width = sanitize_dimension(
			createBinding(monitor, "width")(),
			fallback_monitor_width,
		)
		const height = sanitize_dimension(
			createBinding(monitor, "height")(),
			fallback_monitor_height,
		)
		return {
			width: (rotated ? height : width) / scale,
			height: (rotated ? width : height) / scale,
		}
	}

	function place_client_widget(self: Gtk.Widget, client: AstalHyprland.Client) {
		const parent = self.get_parent()
		if (!(parent instanceof Gtk.Fixed)) return
		const monitor = workspace_monitor(client.get_workspace()?.id ?? 0)
		const factor = scale_factor(options.overview.scale())
		const x = Math.round(factor * (client.get_x() - (monitor?.get_x() ?? 0)))
		const y = Math.round(factor * (client.get_y() - (monitor?.get_y() ?? 0)))
		parent.move(self, x, y)
	}

	function Client({ entry: client, update }: client_props) {
		const class_name = focused_window_client.as((current_client) => {
			const classes: string[] = ["client"]
			if (current_client?.address === client.address) classes.push("active")
			return classes.join(" ")
		})

		const title = create_client_title_accessor(client)
		const content_provider = Gdk.ContentProvider.new_for_value(
			client.get_address(),
		)
		const width_notify = createBinding(client, "width")
		const height_notify = createBinding(client, "height")

		const client_width = createComputed(() => {
			read_client_placement_version()
			width_notify()
			return client.get_width()
		})
		const client_height = createComputed(() => {
			read_client_placement_version()
			height_notify()
			return client.get_height()
		})

		const scaled_width = createComputed(() => Math.round(scale(client_width())))
		const scaled_height = createComputed(() =>
			Math.round(scale(client_height())),
		)

		let widget: Gtk.Widget | null = null
		let update_timer: Timer | null = null
		function run_update() {
			if (!widget) return

			update(widget)
		}

		function schedule_update() {
			if (update_timer) return
			update_timer = idle(() => {
				update_timer = null
				run_update()
			})
		}

		let image_widget: Gtk.Image | null = null

		const setup_client_widget_lifecycle = (self: Gtk.Widget) => {
			widget = self
			let client_connections: number[] = []
			let scale_sub: (() => void) | undefined
			let placement_sub: (() => void) | undefined
			let monitor_sub: (() => void) | undefined

			onMount(() => {
				schedule_update()

				client_connections = client_update_signals.map((signal) =>
					client.connect(signal, schedule_update),
				)

				scale_sub = options.overview.scale.subscribe(schedule_update)
				placement_sub = subscribe_client_placement(schedule_update)
				monitor_sub = createComputed(() => {
					createBinding(hyprland, "monitors")()
					const workspace = createBinding(client, "workspace")()
					const monitor = workspace
						? createBinding(workspace, "monitor")()
						: null
					if (monitor) {
						createBinding(monitor, "x")()
						createBinding(monitor, "y")()
						monitor_size(monitor)
					}
				}).subscribe(schedule_update)
			})

			onCleanup(() => {
				client_connections.forEach((connection) =>
					client.disconnect(connection),
				)
				scale_sub?.()
				placement_sub?.()
				monitor_sub?.()
				update_timer?.cancel()
				widget = null
				image_widget = null
			})
		}

		return (
			<button
				class={class_name}
				tooltipText={title}
				heightRequest={scaled_height}
				widthRequest={scaled_width}
				onClicked={() => client.focus()}
				$={setup_client_widget_lifecycle}
			>
				<image
					$={(self) => (image_widget = self)}
					vexpand
					hexpand
					valign={CENTER}
					halign={CENTER}
					iconName={client.get_class() || "application-x-executable-symbolic"}
					pixelSize={options.scale.as((scale) =>
						Math.round((16 * scale) / 100),
					)}
				/>
				<Gtk.GestureClick
					button={Gdk.BUTTON_MIDDLE}
					onPressed={(self) => {
						client.kill()
						self.reset()
					}}
				/>
				<Gtk.DragSource
					actions={MOVE}
					content={content_provider}
					onDragBegin={(source) => {
						if (image_widget) {
							const paintable = Gtk.WidgetPaintable.new(image_widget)
							source.set_icon(paintable, 8, 8)
						}
					}}
				/>
			</button>
		)
	}

	function Workspace({ entry: workspace_id }: { entry: number }) {
		const class_name = createBinding(hyprland, "focusedWorkspace").as(
			(focused_workspace) => {
				const classes: string[] = ["workspace"]
				if (focused_workspace?.id === workspace_id) classes.push("active")
				return classes.join(" ")
			},
		)

		const css = createComputed(() => {
			const factor = scale_factor(options.overview.scale())
			createBinding(hyprland, "workspaces")()
			const workspace = hyprland.get_workspace(workspace_id)
			const monitor = workspace
				? createBinding(workspace, "monitor")()
				: workspace_monitor(workspace_id)
			const { width, height } = monitor_size(monitor)
			return `min-width: ${factor * width}px; min-height: ${factor * height}px;`
		})

		const clients = create_workspace_clients(workspace_id)

		return (
			<button
				name={`${workspace_id}`}
				class={class_name}
				tooltipText={`${workspace_id}`}
				css={css}
				valign={CENTER}
				onClicked={() =>
					hyprland.message_async(`dispatch workspace ${workspace_id}`, null)
				}
			>
				<Gtk.DropTarget
					actions={MOVE}
					formats={Gdk.ContentFormats.new_for_gtype(GObject.TYPE_STRING)}
					onAccept={(_target, drop) => {
						const formats = drop.get_formats()
						return formats.contain_gtype(GObject.TYPE_STRING)
					}}
					onDrop={(_target, value) => {
						if (
							typeof value !== "string" ||
							!/^(?:0x)?[0-9a-fA-F]+$/.test(value)
						)
							return false
						if (!hyprland.get_client(value)) return false
						move_client_to_workspace_silent(workspace_id, value)
						return true
					}}
				/>
				<Gtk.Fixed hexpand vexpand halign={FILL} valign={FILL}>
					<For each={clients} id={(c) => c.address}>
						{(c) => (
							<Client
								entry={c}
								update={(self) => place_client_widget(self, c)}
							/>
						)}
					</For>
				</Gtk.Fixed>
			</button>
		)
	}

	const { CENTER, FILL } = Gtk.Align
	const { MOVE } = Gdk.DragAction
	const { OVERLAY } = Astal.Layer

	const overview_sync_interval_ms = 250
	const fallback_monitor_width = 1920
	const fallback_monitor_height = 1080
}
