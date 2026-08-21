// Shows Hyprland workspaces and windows in an overview for each monitor.

import { createBinding, createComputed, For, onCleanup, onMount } from "ags"
import { idle } from "ags/time"
import app from "ags/gtk4/app"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import AstalHyprland from "gi://AstalHyprland"

import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "../PanelButton"

import { hyprland } from "$service/astal"
import {
	createClientTitleAccessor,
	filterValidWindowClients,
	focusedWindowClient,
	getClientWorkspaceId,
	moveClientToWorkspaceSilent,
} from "$lib/windowing"

import options from "$shell/options"

export namespace Overview {
	export function Button() {
		const workspaces = createComputed(() => workspaceIds(options.bar.workspaces.count()))
		const clients = createBinding(hyprland, "clients").as(list => filterValidWindowClients(list ?? []))
		const className = (ws: number) => createBinding(hyprland, "focusedWorkspace").as(fws => {
			const classes: string[] = []
			if (fws?.id === ws) classes.push("active")
			if (clients().some(client => getClientWorkspaceId(client) === ws)) classes.push("occupied")
			return classes.join(" ")
		})

		return (
			<PanelButton targetWindow="overview" class="workspaces">
				<box valign={CENTER}>
					<For each={workspaces}>
						{(ws) => {
							return (
								<label valign={CENTER} name={`${ws}`} label={`${ws}`}
									class={className(ws)}
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
		const workspaces = createComputed(() => workspaceIds(options.overview.workspaces()))

		return (
			<PopupWindow application={app} name="overview" layer={OVERLAY}>
				<box class="overview horizontal">
					<For each={workspaces}>{ws => <Workspace entry={ws} />}</For>
				</box>
			</PopupWindow>
		)
	}

	type ClientProps = {
		entry: AstalHyprland.Client
		update: (self: Gtk.Widget) => void
	}

	const HYPR_UPDATE_SIGNALS = ["client-added", "client-moved"] as const
	const CLIENT_UPDATE_SIGNALS = ["notify::x", "notify::y"] as const

	function sanitizeOverviewScale(value: number) {
		return Math.max(1, value)
	}

	function sanitizeDimension(value: number | null | undefined, fallback: number) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			return fallback
		}

		return value
	}

	function scaleFactor(value: number) {
		const safeValue = sanitizeOverviewScale(value)
		if (safeValue <= 15) {
			return safeValue / 100
		}
		return (safeValue / 100) * 9 / 100
	}

	function scale(size: number) {
		return scaleFactor(options.overview.scale()) * size
	}

	function workspaceIds(total: number) {
		return Array.from({ length: Math.max(1, total) }, (_, index) => index + 1)
	}

	function Client({ entry: client, update }: ClientProps) {
		const className = focusedWindowClient.as(currentClient => {
			const classes: string[] = ["client"]
			if (currentClient?.address === client.address) classes.push("active")
			return classes.join(" ")
		})

		const title = createClientTitleAccessor(client)
		const contentProvider = Gdk.ContentProvider.new_for_value(client.get_address())
		const clientWidth = createBinding(client, "width")
		const clientHeight = createBinding(client, "height")

		const scaledWidth = createComputed(() => scale(clientWidth()))
		const scaledHeight = createComputed(() => scale(clientHeight()))

		let widget: Gtk.Widget | null = null
		let updateScheduled = false
		function runUpdate() {
			if (!widget)
				return

			update(widget)
		}

		function scheduleUpdate() {
			if (updateScheduled) return
			updateScheduled = true
			idle(() => {
				runUpdate()
				updateScheduled = false
			})
		}

		let imageWidget: Gtk.Image | null = null

		const setupClientWidgetLifecycle = (self: Gtk.Widget) => {
			widget = self
			let hyprConnections: number[] = []
			let clientConnections: number[] = []
			let scaleSub: (() => void) | undefined

			onMount(() => {
				runUpdate()

				hyprConnections = HYPR_UPDATE_SIGNALS.map(signal =>
					hyprland.connect(signal, scheduleUpdate),
				)

				clientConnections = CLIENT_UPDATE_SIGNALS.map(signal =>
					client.connect(signal, scheduleUpdate),
				)

				scaleSub = options.overview.scale.subscribe(scheduleUpdate)
			})

			onCleanup(() => {
				hyprConnections.forEach(conn => hyprland.disconnect(conn))
				clientConnections.forEach(conn => client.disconnect(conn))
				scaleSub?.()
				widget = null
				imageWidget = null
			})
		}

		return (
			<button class={className} tooltipText={title}
				heightRequest={scaledHeight}
				widthRequest={scaledWidth}
				onClicked={() => client.focus()}
				$={setupClientWidgetLifecycle}
			>
				<image
					$={self => imageWidget = self}
					vexpand hexpand
					valign={CENTER} halign={CENTER}
					iconName={client.get_class()} pixelSize={options.scale.as(scale => Math.round(16 * scale / 100))}
				/>
				<Gtk.DragSource
					actions={MOVE}
					content={contentProvider}
					onDragBegin={source => {
						if (imageWidget) {
							const paintable = Gtk.WidgetPaintable.new(imageWidget)
							source.set_icon(paintable, 8, 8)
						}
					}}
				/>
			</button>
		)
	}

	function Workspace({ entry: workspaceId }: { entry: number }) {
		const className = createBinding(hyprland, "focusedWorkspace").as(fws => {
			const classes: string[] = ["workspace"]
			if (fws?.id === workspaceId) classes.push("active")
			return classes.join(" ")
		})

		const monitor = createBinding(hyprland, "monitors").as(monitors =>
			(monitors ?? []).find(m => m?.id === 0) ?? (monitors ?? [])[0] ?? null,
		)
		const css = createComputed(() => {
			const factor = scaleFactor(options.overview.scale())
			const width = sanitizeDimension(monitor()?.get_width(), FALLBACK_MONITOR_WIDTH)
			const height = sanitizeDimension(monitor()?.get_height(), FALLBACK_MONITOR_HEIGHT)
			return `min-width: ${factor * width}px; min-height: ${factor * height}px;`
		})

		const clients = createBinding(hyprland, "clients").as(list =>
			filterValidWindowClients(list ?? []).filter(client => getClientWorkspaceId(client) === workspaceId),
		)
		let fixed: Gtk.Fixed

		return (
			<button
				name={`${workspaceId}`}
				class={className}
				tooltipText={`${workspaceId}`}
				css={css}
				valign={CENTER}
				onClicked={() => hyprland.message_async(`dispatch workspace ${workspaceId}`, null)}
			>
				<Gtk.DropTarget
					actions={MOVE}
					formats={Gdk.ContentFormats.new_for_gtype(GObject.TYPE_STRING)}
					onAccept={(_, drop) => {
						const formats = drop.get_formats()
						return formats.contain_gtype(GObject.TYPE_STRING)
					}}
					onDrop={(_, value) => {
						if (value) {
							moveClientToWorkspaceSilent(workspaceId, String(value))
						}
						return true
					}}
				/>
				<Gtk.Fixed $={self => fixed = self}>
					<For each={clients}>
						{c => <Client entry={c} update={self => {
							if (self.get_parent() === fixed) {
								fixed.move(self, scale(c.get_x()), scale(c.get_y()))
							}
						}} />
						}
					</For>
				</Gtk.Fixed>
			</button>
		)
	}


	const { CENTER } = Gtk.Align
	const { MOVE } = Gdk.DragAction
	const { OVERLAY } = Astal.Layer

	const FALLBACK_MONITOR_WIDTH = 1920
	const FALLBACK_MONITOR_HEIGHT = 1080
}
