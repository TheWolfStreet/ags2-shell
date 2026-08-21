// Lists monitors and starts or stops mirroring each secondary display.

import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createState, onCleanup, For } from "ags"

import AstalHyprland from "gi://AstalHyprland"

import { Placeholder } from "widget/shared/Placeholder"
import { ToggleButton, Menu, quickSettingsSubmenu } from "./MenuControls"

import icons from "$lib/icons"
import { attemptAsync } from "$lib/result"
import { hyprland } from "$service/astal"

import options from "$shell/options"

export namespace DisplayMirroring {
	export function Toggle() {
		return (
			<ToggleButton
				arrow
				name="mirror-selector"
				iconName={icons.ui.projector}
				label={"Mirror"}
				activate={() => quickSettingsSubmenu.open("mirror-selector")}
				connection={quickSettingsSubmenu.opened.as(v => v === "mirror-selector")}
			/>
		)
	}

	export function Selector() {
		const [monitors, setMonitors] = createState<AstalHyprland.Monitor[]>([])
		let active = true
		const refresh = () => void getMonitors().then(monitors => {
			if (active) setMonitors(monitors)
		})
		const ids = [
			hyprland.connect("monitor-added", refresh),
			hyprland.connect("monitor-removed", refresh),
		]
		const unsubscribeOpened = quickSettingsSubmenu.opened.subscribe(() => {
			if (quickSettingsSubmenu.opened.peek() === "mirror-selector") refresh()
		})
		if (quickSettingsSubmenu.opened.peek() === "mirror-selector") refresh()

		onCleanup(() => {
			active = false
			unsubscribeOpened()
			ids.forEach(id => hyprland.disconnect(id))
		})

		const hasMonitors = monitors.as(ms => ms.length > 0)
		return (
			<Menu
				name={"mirror-selector"}
				iconName={icons.ui.projector}
				title={"Display devices"}
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
											update={refresh}
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

	const { CENTER } = Gtk.Align
	const { VERTICAL } = Gtk.Orientation
	const { NEVER } = Gtk.PolicyType

	type MirrorAwareMonitor = AstalHyprland.Monitor & {
		mirrorOf?: string | null
	}

	async function getMonitors(): Promise<AstalHyprland.Monitor[]> {
		const result = await attemptAsync(async () =>
			(JSON.parse(await execAsync(["hyprctl", "monitors", "all", "-j"])) as AstalHyprland.Monitor[]).filter(m => m.id !== 0))
		if (!result.ok) {
			console.error("Error fetching monitors:", result.err)
			return []
		}
		return result.value
	}

	function Entry({ monitor, update }: { monitor: AstalHyprland.Monitor, update: () => void }) {
		const mirrorOf = (monitor as MirrorAwareMonitor).mirrorOf
		const canEnableMirror = (mirrorOf ?? "none") === "none"

		return (
			<button
				onClicked={() => {
					const primaryMonitorName = hyprland.get_monitor(0)?.name
					const mirrorSuffix = canEnableMirror && primaryMonitorName
						? `, mirror, ${primaryMonitorName}`
						: ""
					const command = `keyword monitor ${monitor.name}, highres, auto, 1${mirrorSuffix}`
					hyprland.message_async(command, null)
					update()
				}}
			>
				<box class="mirror-item horizontal">
					<image iconName={icons.ui.projector} pixelSize={options.scale.as(scale => Math.round(16 * scale / 100))} />
					<label label={`${monitor.model} (${monitor.name}) ${canEnableMirror ? "" : "(Mirrored)"}`} />
				</box>
			</button>
		)
	}
}
