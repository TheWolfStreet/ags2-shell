import {
	type Accessor,
	createBinding,
	createComputed,
	For,
	onCleanup,
	onMount,
} from "ags"
import { idle, timeout, type timer } from "$lib/time"
import app from "$lib/app"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import AstalHyprland from "gi://AstalHyprland"

import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "../PanelButton"

import { hyprland, hyprland_command } from "$lib/hyprland"
import { attempt, log_error } from "$lib/result"
import {
	close_client,
	create_client_title_accessor,
	create_workspace_clients,
	focus_client,
	focused_window_client,
	move_client_to_workspace_silent,
	on_window_toggle,
	client_placement_version,
	refresh_client_placement,
} from "$lib/windowing"

import options, { scaled } from "$shell/options"
import icons from "$lib/icons"

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
			<PanelButton target_window="overview" class="workspaces">
				<box valign={CENTER}>
					<For each={workspaces}>
						{(workspace_id) => (
							<label
								valign={CENTER}
								name={`${workspace_id}`}
								label={`${workspace_id}`}
								class={class_name(workspace_id)}
							/>
						)}
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

		let sync_timer: timer | null = null
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
				sync_when_idle()
			})
		}

		const sync_when_idle = () => {
			if (in_flight) schedule_sync()
			else sync_now()
		}

		const stop_sync = () => {
			visible = false
			generation++
			sync_timer?.cancel()
			sync_timer = null
		}

		const warn_sync_failure = (error: unknown) => {
			if (!sync_warned)
				console.warn("overview: Hyprland client sync failed", error)
			sync_warned = true
		}

		const refresh_if_moved = () => {
			const snapshot = client_snapshot()
			if (snapshot === previous_snapshot) return
			previous_snapshot = snapshot
			refresh_client_placement()
		}

		const sync_now = () => {
			if (in_flight) return
			in_flight = true
			const current_generation = generation
			hyprland.sync_clients((_source, result) => {
				const synced = attempt(() => hyprland.sync_clients_finish(result))
				if (!synced.ok) warn_sync_failure(synced.err)
				in_flight = false
				if (synced.ok && current_generation === generation) {
					sync_warned = false
					refresh_if_moved()
				}
				schedule_sync()
			})
		}

		const start_sync = () => {
			stop_sync()
			visible = true
			sync_when_idle()
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

	function client_key(client: AstalHyprland.Client) {
		return [
			client.address,
			client.workspace?.id,
			client.x,
			client.y,
			client.width,
			client.height,
		].join(":")
	}

	function client_snapshot() {
		return hyprland.clients.map(client_key).sort().join("|")
	}

	function is_client_address(value: unknown): value is string {
		return typeof value === "string" && /^(?:0x)?[0-9a-fA-F]+$/.test(value)
	}

	function sanitize_dimension(
		value: number | null | undefined,
		fallback: number,
	) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
			return fallback

		return value
	}

	function scale_factor(value: number) {
		const safe_value = Math.max(1, value)
		if (safe_value <= 15) return safe_value / 100
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

	function scaled_size(notify: Accessor<number>, read: () => number) {
		return createComputed(() => {
			client_placement_version()
			notify()
			return Math.round(scale(read()))
		})
	}

	function track_monitor(client: AstalHyprland.Client) {
		return createComputed(() => {
			createBinding(hyprland, "monitors")()
			const workspace = createBinding(client, "workspace")()
			const monitor = workspace ? createBinding(workspace, "monitor")() : null
			if (!monitor) return
			createBinding(monitor, "x")()
			createBinding(monitor, "y")()
			monitor_size(monitor)
		})
	}

	function Client({ entry: client, update }: client_props) {
		const class_name = focused_window_client.as((current_client) =>
			current_client?.address === client.address ? "client active" : "client",
		)

		const title = create_client_title_accessor(client)
		const content_provider = Gdk.ContentProvider.new_for_value(
			client.get_address(),
		)
		const scaled_width = scaled_size(createBinding(client, "width"), () =>
			client.get_width(),
		)
		const scaled_height = scaled_size(createBinding(client, "height"), () =>
			client.get_height(),
		)

		let widget: Gtk.Widget | null = null
		let update_timer: timer | null = null
		function schedule_update() {
			if (update_timer) return
			update_timer = idle(() => {
				update_timer = null
				if (widget) update(widget)
			})
		}

		let image_widget: Gtk.Image | null = null

		const setup_client_widget_lifecycle = (self: Gtk.Widget) => {
			widget = self
			const disposers: (() => void)[] = []

			onMount(() => {
				schedule_update()
				const connections = client_update_signals.map((signal) =>
					client.connect(signal, schedule_update),
				)
				disposers.push(
					() => connections.forEach((id) => client.disconnect(id)),
					options.overview.scale.subscribe(schedule_update),
					client_placement_version.subscribe(schedule_update),
					track_monitor(client).subscribe(schedule_update),
				)
			})

			onCleanup(() => {
				for (const dispose of disposers) dispose()
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
				onClicked={() => void focus_client(client)}
				$={setup_client_widget_lifecycle}
			>
				<image
					$={(self) => {
						image_widget = self
					}}
					vexpand
					hexpand
					valign={CENTER}
					halign={CENTER}
					iconName={client.get_class() || icons.fallback.app}
					pixelSize={scaled(16)}
				/>
				<Gtk.GestureClick
					button={Gdk.BUTTON_MIDDLE}
					onPressed={(self) => {
						void close_client(client)
						self.reset()
					}}
				/>
				<Gtk.DragSource
					actions={MOVE}
					content={content_provider}
					onDragBegin={(source) => {
						if (!image_widget) return
						source.set_icon(Gtk.WidgetPaintable.new(image_widget), 8, 8)
					}}
				/>
			</button>
		)
	}

	function Workspace({ entry: workspace_id }: { entry: number }) {
		const class_name = createBinding(hyprland, "focusedWorkspace").as(
			(focused_workspace) =>
				focused_workspace?.id === workspace_id
					? "workspace active"
					: "workspace",
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
					void hyprland_command(
						`dispatch hl.dsp.focus({ workspace = ${workspace_id} })`,
					).then((result) =>
						log_error(result, "overview.workspace: Failed to switch workspace"),
					)
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
						if (!is_client_address(value)) return false
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
