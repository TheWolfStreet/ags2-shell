import { Gtk } from "ags/gtk4"
import { exec } from "ags/process"
import { createState, onCleanup, For } from "ags"

import AstalHyprland from "gi://AstalHyprland?version=0.1"

import { Placeholder } from "widget/shared/Placeholder"
import { ArrowToggleButton, set_opened, opened, Menu } from "./shared/MenuElements"

import icons from "$lib/icons"
import { hypr } from "$lib/services"

import options from "options"

const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { NEVER } = Gtk.PolicyType

export namespace Mirror {
	function getMonitors() {
		try {
			return (JSON.parse(exec("hyprctl monitors all -j")) as AstalHyprland.Monitor[]).filter(m => m.id !== 0)
		} catch (error) {
			console.error("Error fetching monitors:", error)
			return []
		}
	}

	function Entry({ monitor, update }: { monitor: AstalHyprland.Monitor, update: () => void }) {
		// @ts-ignore: NOTE: A hacky way tracking mirroring in the existing type
		const mirrored = monitor.mirrorOf == "none"

		return (
			<button
				onClicked={() => {
					const command = `keyword monitor ${monitor.name}, highres, auto, 1${mirrored ? `, mirror, ${hypr?.get_monitor(0).name}` : ''}`
					hypr.message_async(command, null)
					update()
				}}
			>
				<box class="mirror-item horizontal">
					<image iconName={icons.ui.projector} pixelSize={16} />
					<label label={`${monitor.model} (${monitor.name}) ${mirrored ? "" : "(Mirrored)"}`} />
				</box>
			</button>
		)
	}

	const [monitors, set_monitors] = createState(getMonitors())

	export function Toggle() {
		return (
			<ArrowToggleButton
				name="mirror-selector"
				iconName={icons.ui.projector}
				label={"Mirror"}
				activate={() => set_opened("mirror-selector")}
				connection={opened.as(v => v == "mirror-selector")}
			/>
		)
	}

	export function Selector() {
		const ids = [
			hypr.connect("monitor-added", () => set_monitors(getMonitors())),
			hypr.connect("monitor-removed", () => set_monitors(getMonitors()))
		]

		onCleanup(() => {
			ids.forEach(id => hypr.disconnect(id));
		})

		const hasMonitors = monitors.as(ms => ms.length > 0)
		return (
			<Menu
				name={"mirror-selector"}
				iconName={icons.ui.projector}
				title={"Select display device"}
			>
				<box orientation={VERTICAL}>
					<revealer
						halign={CENTER}
						revealChild={hasMonitors.as(v => !v)}
						transitionDuration={options.transition.duration}
					>
						<Placeholder iconName={icons.missing} label={"No display devices found"} />
					</revealer>
					<revealer revealChild={hasMonitors} transitionDuration={options.transition.duration}>
						<Gtk.ScrolledWindow class="device-scroll" hscrollbarPolicy={NEVER}>
							<box orientation={VERTICAL} vexpand hexpand>
								<For each={monitors}>
									{(monitor) => (
										<Entry
											monitor={monitor}
											update={() => { set_monitors(getMonitors()) }}
										/>
									)}
								</For>
							</box>
						</Gtk.ScrolledWindow>
					</revealer>
				</box>
			</Menu>
		)
	}
}

