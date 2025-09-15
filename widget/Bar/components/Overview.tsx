import { createBinding, createComputed, For, Node, onCleanup, onMount } from "ags"
import { idle } from "ags/time"
import app from "ags/gtk4/app"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import AstalHyprland from "gi://AstalHyprland"

import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "./PanelButton"

import { getClientTitle, toggleWindow } from "$lib/utils"
import { hypr } from "$lib/services"

import options from "options"

const { CENTER } = Gtk.Align
const { MOVE } = Gdk.DragAction
const { OVERLAY } = Astal.Layer

function scale(size: number) {
	return (options.overview.scale.get() / 100) * size
}

export namespace Workspaces {

	function dummyWorkspaces(ws: AstalHyprland.Workspace[], total: number) {
		const existing_ids = new Set(ws.map(w => w.id))
		for (let id = 1; id <= total; id++) {
			if (!existing_ids.has(id)) {
				ws.push({
					id,
					get_id() { return this.id },
					disconnect() { },
					connect() { },
					focus() { hypr.message_async(`dispatch workspace ${this.id}`, null) },
					clients: [],
					monitor: undefined,
				} as any as AstalHyprland.Workspace)
			}
		}
		return ws.sort((a, b) => a.id - b.id)
	}

	function Client({ entry: c, update }: { entry: AstalHyprland.Client, update: (self: Gtk.Widget) => void }) {

		const className = createBinding(hypr, "focusedClient").as(fc => {
			const classes: string[] = ["client"]
			if (fc && fc.address === c.address) classes.push("active")
			return classes.join(" ")
		})
		const title = getClientTitle(c)
		const contentProvider = Gdk.ContentProvider.new_for_value(c.get_address())

		let updateScheduled = false
		function scheduleUpdate(self: Gtk.Widget) {
			if (updateScheduled) return
			updateScheduled = true
			idle(() => {
				update(self)
				updateScheduled = false
			})
		}

		return (
			<button class={className} tooltipText={title}
				heightRequest={createBinding(c, "height").as(scale)}
				widthRequest={createBinding(c, "width").as(scale)}
				onClicked={() => c.focus()}
				$={self => {
					let hyprConnections: number[] = []
					let clientConnections: number[] = []

					onMount(() => {
						update(self)

						hyprConnections = ["client-added", "client-moved"].map(e =>
							hypr.connect(e, () => scheduleUpdate(self))
						)

						clientConnections = ["notify::x", "notify::y"].map(e =>
							c.connect(e, () => scheduleUpdate(self))
						)
					})

					onCleanup(() => {
						hyprConnections.forEach(conn => hypr.disconnect(conn))
						clientConnections.forEach(conn => c.disconnect(conn))
					})
				}}
			>
				<image
					vexpand hexpand
					valign={CENTER} halign={CENTER}
					iconName={c.get_class()} pixelSize={16}
				/>
				<Gtk.DragSource
					actions={MOVE}
					content={contentProvider}
				/>
			</button>
		)
	}

	function Workspace({ entry: ws }: { entry: AstalHyprland.Workspace }) {
		const className = createBinding(hypr, "focusedWorkspace").as(fws => {
			const classes: string[] = ["workspace"]
			if (fws?.id === ws?.id) classes.push("active")
			return classes.join(" ")
		})

		const css = createComputed(
			[options.overview.scale, createBinding(ws, "monitor")],
			(scale, monitor) => {
				const width = monitor?.get_width() ?? 1920
				const height = monitor?.get_height() ?? 1080
				return `min-width: ${(scale / 100) * width}px; min-height: ${(scale / 100) * height}px;`
			}
		)

		const clients = createBinding(ws, "clients")
		let fixed: Gtk.Fixed

		return (
			<button
				name={`${ws.get_id()}`}
				class={className}
				tooltipText={`${ws.get_id()}`}
				css={css}
				valign={CENTER}
				onClicked={() => ws.focus()}
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
							hypr.message_async(`dispatch movetoworkspacesilent ${ws.get_id()},address:0x${value}`, null)
						}
						return true
					}}
				/>
				<Gtk.Fixed $={self => fixed = self}>
					<For each={clients}>
						{c => <Client entry={c} update={self => {
							if (self.get_parent() === fixed) fixed.move(self, scale(c.get_x()), scale(c.get_y()))
						}} />
						}
					</For>
				</Gtk.Fixed>
			</button>
		)
	}

	export function Button() {
		const workspaces = createComputed(
			[createBinding(hypr, "workspaces"), options.bar.workspaces.count],
			(ws, fill) => dummyWorkspaces(ws.filter(w => w?.id !== -99).sort((a, b) => a?.id - b?.id), fill)
		)

		return (
			<PanelButton name="overview" class="workspaces" onClicked={() => toggleWindow("overview")}>
				<box valign={CENTER}>
					<For each={workspaces}>
						{(ws) => {
							const className = createBinding(hypr, "focusedWorkspace")
								.as(fws => {
									const classes: string[] = []
									if (fws?.id === ws?.id) classes.push("active")
									if (ws?.clients.length) classes.push("occupied")
									return classes.join(" ")
								})

							return (
								<label valign={CENTER} name={`${ws?.id}`} label={`${ws?.id}`}
									class={className}
								/>
							)
						}}
					</For>
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		const workspaces = createComputed(
			[createBinding(hypr, "workspaces"), options.overview.workspaces],
			(ws, fill) => dummyWorkspaces(ws.filter(w => w.id !== -99).sort((a, b) => a.id - b.id), fill)
		)

		return (
			<PopupWindow application={app} name="overview" layer={OVERLAY}>
				<box class="overview horizontal">
					<For each={workspaces}>{ws => <Workspace entry={ws} />}</For>
				</box>
			</PopupWindow>
		)
	}
}
