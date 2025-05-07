import Hyprland from "gi://AstalHyprland"
import { bind } from "astal"
import { Gtk, Gdk, Widget, Astal } from "astal/gtk3"

import { Fixed } from "../../GtkWidgets"
import PopupWindow from "../../PopupWindow"
import PanelButton from "./PanelButton"

import { hypr } from "../../../lib/services"
import { initHook, range, toggleWindow } from "../../../lib/utils"
import options from "../../../options"

const target = [Gtk.TargetEntry.new("text/plain", Gtk.TargetFlags.SAME_APP, 0)]
const { CENTER } = Gtk.Align

function scale(size: number) { (options.overview.scale.get() / 100) * size }

export function Workspaces() {
	const labels = (ws: number) =>
		<box setup={self => {
			if (ws == 0) {
				initHook(self, bind(hypr, "focusedWorkspace"), () => {
					self.children.map(label => {
						label.visible = hypr.workspaces.some(ws => `${ws.id} ` == label.name)
					})
				})
			}
		}}>
			{
				range(ws || 20).map(i => (
					<label
						name={`${i} `}
						label={`${i} `}
						setup={self => {
							initHook(self, bind(hypr, "focusedWorkspace"), () => {
								if (hypr.focusedWorkspace) {
									self.toggleClassName("active", hypr.focusedWorkspace.id === i)
									self.toggleClassName("occupied", hypr.get_workspace(i)?.clients.length > 0)
								}
							})
						}}
						valign={CENTER}
					/>
				))
			}
		</box >


	return (
		<PanelButton name="overview" className="workspaces" onClicked={() => toggleWindow("overview")}>
			{options.bar.workspaces.count(labels)}
		</PanelButton>
	)
}

function size(id: number) {
	const def = { h: 1080, w: 1920 }
	const ws = hypr.get_workspace(id)

	if (ws === null || typeof ws === "undefined") return def
	const mon = hypr.get_monitor(ws.monitor.id)

	return mon ? { h: mon.height, w: mon.width } : def
}

function Window({ address, size: [w, h], class: c, title }: any) {
	return (
		<button
			className="client"
			name={address}
			tooltipText={`${title}`}
			onDragDataGet={(_w, _c, data) => {
				data.set_text(address, address.length)
			}}
			onDragBegin={(self, _a, _b) => {
				self.toggleClassName("hidden", true)
			}}
			onDragEnd={self => {
				self.toggleClassName("hidden", false)
			}}
			setup={self => {
				self.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, target, Gdk.DragAction.COPY)
			}}
			onClick={(_: Widget.Button, event: Astal.ClickEvent) => {
				const client = hypr.get_client(address)
				const { BUTTON_PRIMARY, BUTTON_MIDDLE, BUTTON_SECONDARY } = Gdk

				if (client && event.release) {
					switch (event.button) {
						case BUTTON_PRIMARY:
							toggleWindow("overview")
							client.focus()
							break
						case BUTTON_SECONDARY:
							client.focus()
							hypr.message_async(`dispatch fullscreen`, null)
							break
						case BUTTON_MIDDLE:
							client.kill()
							break
						default:
							break
					}
				}
			}}
			onKeyPressEvent={(_, event: Gdk.Event) => {
				const client = hypr.get_client(address)
				if (client && event.get_keyval()[1] === Gdk.KEY_Return) {
					toggleWindow("overview")
					client.focus()
				}
			}}
		>
			<icon
				icon={c}
				useFallback
				css={options.overview.scale((v) => `
                min-width: ${(v / 100) * w}px;
                min-height: ${(v / 100) * h}px;
      `)}
			/>
		</button >
	)
}

function Workspace(id: number) {
	const fixed = <Fixed /> as Gtk.Fixed

	async function update() {
		const json = hypr.message("j/clients")
		if (!json)
			return

		fixed.get_children().forEach((ch) => ch.destroy())

		JSON.parse(json).filter(({ workspace }: { workspace: Hyprland.Workspace }) => workspace.id === id)
			.forEach((c: any) => {
				const x = c.at[0] - (hypr.get_monitor(c.monitor)?.x || 0)
				const y = c.at[1] - (hypr.get_monitor(c.monitor)?.y || 0)
				c.mapped && fixed.put(Window(c), scale(x), scale(y))
			})
	}

	return (
		<box
			name={`${id}`}
			tooltipText={`${id}`}
			className="workspace"
			valign={CENTER}
			css={options.overview.scale(v => `
          min-width: ${(v / 100) * size(id).w}px;
          min-height: ${(v / 100) * size(id).h}px;
        `
			)}
			setup={self => {
				initHook(self, bind(hypr, "focusedWorkspace"), () => {
					if (hypr.focusedWorkspace) {
						self.toggleClassName("active", hypr.focusedWorkspace.id == id)
					}
				})

				self.hook(hypr, "client-moved", update)
				self.hook(hypr, "event", (_, e) => {
					if (e == "openwindow" || e == "closewindow" || e == "activewindow") {
						update()
					}
				})

				initHook(self, options.overview.scale, update)
			}}
		>
			<eventbox
				vexpand hexpand
				onClick={() => {
					toggleWindow("overview")
					hypr.message_async(`dispatch workspace ${id}`, null)
				}}
				onDragDataReceived={(_w, _c, _x, _y, data) => {
					const address = data.get_text()
					if (address) {
						hypr.message_async(`dispatch movetoworkspacesilent ${id},address:${address}`, null)
					}
				}}
				setup={self => {
					self.drag_dest_set(Gtk.DestDefaults.ALL, target, Gdk.DragAction.COPY)
				}}
				child={fixed}
			/>
		</box >
	)
}

function Entry(ws: number) {
	return (
		<box className="overview horizontal"
			setup={self => {
				if (ws > 0)
					return

				self.hook(hypr, "workspace-removed", (_, id) => {
					if (id === undefined)
						return

					self.get_children().filter(c => c.name == id).forEach(c => c.destroy())
				})

				self.hook(hypr, "workspace-added", (_, id) => {
					if (id === undefined)
						return

					self.children = [...self.children, Workspace(Number(id))]
						.sort((a, b) => Number(a.name) - Number(b.name))
				})
			}}
		>
			{ws > 0
				? range(ws).map(Workspace)
				: hypr.workspaces
					.map(({ id }) => Workspace(id))
					.sort((a, b) => Number(a.name) - Number(b.name))}
		</box>
	)
}

export default () =>
	<PopupWindow
		name={"overview"}
		layout={"center"}
	>
		{options.overview.workspaces(Entry)}
	</PopupWindow>
