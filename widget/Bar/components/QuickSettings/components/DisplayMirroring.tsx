import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createState, onCleanup, For } from "ags"

import { Placeholder } from "widget/shared/Placeholder"
import { ToggleButton, Menu, quick_settings_submenu } from "./MenuControls"

import icons from "$lib/icons"
import { attempt_async, type Result } from "$lib/result"
import { hyprland } from "$lib/hyprland"
import { format_monitor_command, type monitor_settings } from "$service/monitorConfiguration"
import options from "$shell/options"

type monitor_configuration = monitor_settings & {
	model: string
	disabled: boolean
}

function is_monitor(value: unknown): value is monitor_configuration {
	if (value === null || typeof value !== "object") return false
	const monitor = value as Record<string, unknown>
	if (typeof monitor.name !== "string" || typeof monitor.model !== "string" ||
		typeof monitor.disabled !== "boolean") return false
	if (monitor.mirrorOf != null && typeof monitor.mirrorOf !== "string") return false
	if (!["x", "y", "width", "height", "refreshRate", "scale", "transform"].every((key) =>
		typeof monitor[key] === "number" && Number.isFinite(monitor[key]))) return false
	return monitor.disabled || Number(monitor.width) > 0 &&
		Number(monitor.height) > 0 && Number(monitor.scale) > 0
}

function read_monitors(): Promise<Result<monitor_configuration[]>> {
	return attempt_async(async () => {
		const parsed: unknown = JSON.parse(await execAsync(["hyprctl", "monitors", "all", "-j"]))
		if (!Array.isArray(parsed) || !parsed.every(is_monitor))
			throw new Error("Invalid monitor configuration")
		return parsed as monitor_configuration[]
	})
}

function source_monitor(monitors: monitor_configuration[], excluded = "") {
	const eligible = monitors.filter((monitor) =>
		!monitor.disabled && monitor.name !== excluded &&
		(!monitor.mirrorOf || monitor.mirrorOf === "none"))
	return eligible.find((monitor) => monitor.name === hyprland.focusedMonitor?.name)?.name ?? eligible[0]?.name
}

export namespace DisplayMirroring {
	const original = new Map<string, monitor_configuration>()

	export function Toggle() {
		return (
			<ToggleButton
				arrow
				name="mirror-selector"
				iconName={icons.ui.projector}
				label="Mirror"
				onToggle={() => quick_settings_submenu.toggle("mirror-selector")}
				connection={quick_settings_submenu.opened.as((name) => name === "mirror-selector")}
			/>
		)
	}

	export function Selector() {
		const [monitors, set_monitors] = createState<monitor_configuration[]>([])
		let active = true
		let revision = 0
		const refresh = () => {
			const current = ++revision
			void read_monitors().then((result) => {
				if (!active || current !== revision) return
				if (result.ok) {
					for (const name of original.keys())
						if (!result.value.some((item) => item.name === name && !item.disabled)) original.delete(name)
					set_monitors(result.value)
				}
				else console.error("DisplayMirroring.read:", result.err)
			})
		}
		const handlers = [
			hyprland.connect("monitor-added", refresh),
			hyprland.connect("monitor-removed", refresh),
		]
		const unsubscribe = quick_settings_submenu.opened.subscribe(() => {
			if (quick_settings_submenu.opened.peek() === "mirror-selector") refresh()
		})
		if (quick_settings_submenu.opened.peek() === "mirror-selector") refresh()
		onCleanup(() => {
			active = false
			revision++
			unsubscribe()
			for (const handler of handlers) hyprland.disconnect(handler)
		})

		const has_monitors = monitors.as((list) => list.filter((monitor) => !monitor.disabled).length > 1)
		return <Menu name="mirror-selector" iconName={icons.ui.projector} title="Display devices">
			<box orientation={Gtk.Orientation.VERTICAL}>
				<revealer halign={Gtk.Align.CENTER} revealChild={has_monitors.as((value) => !value)}
					transitionDuration={options.transition.duration}>
					<Placeholder iconName={icons.missing} label="No secondary display found" />
				</revealer>
				<revealer revealChild={has_monitors} transitionDuration={options.transition.duration}>
					<Gtk.ScrolledWindow class="device-scroll" hscrollbarPolicy={Gtk.PolicyType.NEVER}>
						<box orientation={Gtk.Orientation.VERTICAL} vexpand hexpand>
							<For each={monitors.as((list) => {
								const source = source_monitor(list)
								return list.filter((monitor) => !monitor.disabled && monitor.name !== source)
							})}>
								{(monitor: monitor_configuration) => <Entry monitor={monitor} refresh={refresh} />}
							</For>
						</box>
					</Gtk.ScrolledWindow>
				</revealer>
			</box>
		</Menu>
	}

	function Entry({ monitor, refresh }: { monitor: monitor_configuration, refresh: () => void }) {
		let pending = false
		const mirrored = Boolean(monitor.mirrorOf && monitor.mirrorOf !== "none")
		const click = async () => {
			if (pending) return
			pending = true
			try {
				const current = await read_monitors()
				if (!current.ok) {
					console.error("DisplayMirroring.read:", current.err)
					return
				}
				const target = current.value.find((item) => item.name === monitor.name && !item.disabled)
				if (!target) return
				let command: string
				if (target.mirrorOf && target.mirrorOf !== "none") {
					command = format_monitor_command(original.get(target.name) ?? target, { mirror: "none" })
				} else {
					const source = source_monitor(current.value, target.name)
				if (!source || !current.value.some((item) => item.name === source && !item.disabled)) {
						console.error("DisplayMirroring: No source monitor available")
						return
					}
					command = format_monitor_command(target, { mirror: source })
				}
				const applied = await attempt_async(() => hyprland.message_async(command))
				if (!applied.ok || applied.value !== "ok") {
					console.error("DisplayMirroring: Failed to change display configuration", applied.ok ? applied.value : applied.err)
					return
				}
				if (target.mirrorOf && target.mirrorOf !== "none") original.delete(target.name)
				else original.set(target.name, target)
				refresh()
			} finally {
				pending = false
			}
		}
		return <button onClicked={() => void click()}>
			<box class="mirror-item horizontal">
				<image iconName={icons.ui.projector} pixelSize={options.scale.as((scale) => Math.round(16 * scale / 100))} />
				<label label={`${monitor.model} (${monitor.name}) ${mirrored ? "(Mirrored)" : ""}`} />
			</box>
		</button>
	}
}
