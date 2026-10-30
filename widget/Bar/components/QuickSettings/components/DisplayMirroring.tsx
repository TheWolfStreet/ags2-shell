import { Gtk } from "ags/gtk4"
import { createState, onCleanup, For } from "ags"

import { Placeholder } from "widget/shared/Placeholder"
import { ToggleButton, Menu, quick_settings_submenu } from "./MenuControls"

import icons from "$lib/icons"
import {
	attempt,
	attempt_async,
	err,
	log_error,
	ok,
	type result,
} from "$lib/result"
import { hyprland, hyprland_command } from "$lib/hyprland"
import { timeout } from "$lib/time"
import {
	format_monitor_command,
	is_monitor_settings,
	type monitor_settings,
} from "$service/monitor_configuration"
import options, { scaled } from "$shell/options"

type monitor_configuration = monitor_settings & {
	id?: number
	model: string
	disabled: boolean
}

function is_monitor(value: unknown): value is monitor_configuration {
	if (!is_monitor_settings(value)) return false
	const monitor = value as monitor_settings & Record<string, unknown>
	if (typeof monitor.model !== "string") return false
	if (typeof monitor.disabled !== "boolean") return false
	if (monitor.mirrorOf != null && typeof monitor.mirrorOf !== "string")
		return false
	if (monitor.disabled) return true
	return monitor.width > 0 && monitor.height > 0 && monitor.scale > 0
}

async function read_monitors(): Promise<result<monitor_configuration[]>> {
	const reply = await attempt_async(() =>
		hyprland.message_async("j/monitors all"),
	)
	if (!reply.ok) return reply

	const parsed = attempt((): unknown => JSON.parse(reply.value))
	if (!parsed.ok) return parsed
	if (!Array.isArray(parsed.value) || !parsed.value.every(is_monitor))
		return err(new Error("Invalid monitor configuration"))
	const monitors = parsed.value as monitor_configuration[]
	for (const monitor of monitors) {
		const source = monitors.find(
			(source) =>
				typeof source.id === "number" && String(source.id) === monitor.mirrorOf,
		)
		if (source) monitor.mirrorOf = source.name
	}
	return ok(monitors)
}

function is_mirrored(monitor: monitor_configuration) {
	return Boolean(monitor.mirrorOf && monitor.mirrorOf !== "none")
}

function enabled_monitor(monitors: monitor_configuration[], name: string) {
	return monitors.find((monitor) => monitor.name === name && !monitor.disabled)
}

function source_monitor(monitors: monitor_configuration[], excluded = "") {
	const eligible = monitors.filter(
		(monitor) =>
			!monitor.disabled && monitor.name !== excluded && !is_mirrored(monitor),
	)
	const focused = hyprland.focusedMonitor?.name
	const preferred = eligible.find((monitor) => monitor.name === focused)
	return (preferred ?? eligible[0])?.name
}

function mirror_targets(monitors: monitor_configuration[]) {
	const source = source_monitor(monitors)
	return monitors.filter(
		(monitor) => !monitor.disabled && monitor.name !== source,
	)
}

export namespace DisplayMirroring {
	const menu_name = "mirror-selector"
	const original = new Map<string, monitor_configuration>()
	const resetting = new Set<string>()

	export function Toggle() {
		return (
			<ToggleButton
				arrow
				name={menu_name}
				iconName={icons.ui.projector}
				label="Mirror"
				onToggle={() => quick_settings_submenu.toggle(menu_name)}
				connection={quick_settings_submenu.opened.as(
					(name) => name === menu_name,
				)}
			/>
		)
	}

	export function Selector() {
		const [monitors, set_monitors] = createState<monitor_configuration[]>([])
		let active = true
		let revision = 0
		const refresh = async () => {
			revision += 1
			const current = revision
			const read = await read_monitors()
			if (!active || current !== revision) return
			if (!log_error(read, "display_mirroring.read:")) return
			forget_vanished(read.value)
			set_monitors(read.value)
		}
		const refresh_if_open = () => {
			if (quick_settings_submenu.opened.peek() === menu_name) void refresh()
		}
		const handlers = [
			hyprland.connect("monitor-added", () => void refresh()),
			hyprland.connect("monitor-removed", () => void refresh()),
		]
		const unsubscribe = quick_settings_submenu.opened.subscribe(refresh_if_open)
		refresh_if_open()
		onCleanup(() => {
			active = false
			revision += 1
			unsubscribe()
			for (const handler of handlers) hyprland.disconnect(handler)
		})

		const has_monitors = monitors.as(
			(list) => list.filter((monitor) => !monitor.disabled).length > 1,
		)
		return (
			<Menu
				name={menu_name}
				iconName={icons.ui.projector}
				title="Display devices"
			>
				<box orientation={Gtk.Orientation.VERTICAL}>
					<revealer
						halign={Gtk.Align.CENTER}
						revealChild={has_monitors.as((value) => !value)}
						transitionDuration={options.transition.duration}
					>
						<Placeholder
							iconName={icons.missing}
							label="No secondary display found"
						/>
					</revealer>
					<revealer
						revealChild={has_monitors}
						transitionDuration={options.transition.duration}
					>
						<Gtk.ScrolledWindow
							class="device-scroll"
							hscrollbarPolicy={Gtk.PolicyType.NEVER}
						>
							<box orientation={Gtk.Orientation.VERTICAL} vexpand hexpand>
								<For each={monitors.as(mirror_targets)}>
									{(monitor: monitor_configuration) => (
										<Entry monitor={monitor} refresh={refresh} />
									)}
								</For>
							</box>
						</Gtk.ScrolledWindow>
					</revealer>
				</box>
			</Menu>
		)
	}

	function forget_vanished(monitors: monitor_configuration[]) {
		for (const name of original.keys())
			if (!resetting.has(name) && !enabled_monitor(monitors, name))
				original.delete(name)
	}

	async function wait_disabled(name: string): Promise<result<void>> {
		for (let tries = 0; tries < 20; tries++) {
			const monitors = await read_monitors()
			if (!monitors.ok) return monitors
			const monitor = monitors.value.find((monitor) => monitor.name === name)
			if (!monitor) return err(new Error(`Monitor disappeared: ${name}`))
			if (monitor.disabled) return ok(undefined)
			await new Promise<void>((resolve) => timeout(25, resolve))
		}
		return err(new Error(`Timed out disabling monitor: ${name}`))
	}

	async function unmirror(target: monitor_configuration) {
		const command = format_monitor_command(
			original.get(target.name) ?? target,
			{ mirror: "none", disabled: false },
		)
		resetting.add(target.name)
		let applied = await hyprland_command(
			format_monitor_command(target, { disabled: true }),
		)
		if (applied.ok) {
			applied = await wait_disabled(target.name)
			if (applied.ok) applied = await hyprland_command(command)
			if (!applied.ok)
				log_error(
					await hyprland_command(
						format_monitor_command(target, { disabled: false }),
					),
					"display_mirroring: Failed to restore display",
				)
		}
		resetting.delete(target.name)
		return applied
	}

	async function toggle_mirror(name: string, refresh: () => Promise<void>) {
		const current = await read_monitors()
		if (!log_error(current, "display_mirroring.read:")) return
		const target = enabled_monitor(current.value, name)
		if (!target) return
		const message = "display_mirroring: Failed to change display configuration"
		if (is_mirrored(target)) {
			if (!log_error(await unmirror(target), message)) return
			original.delete(target.name)
		} else {
			const source = source_monitor(current.value, target.name)
			if (!source) {
				console.error("display_mirroring: No source monitor available")
				return
			}
			const applied = await hyprland_command(
				format_monitor_command(target, { mirror: source }),
			)
			if (!log_error(applied, message)) return
			original.set(target.name, target)
		}
		void refresh()
	}

	function Entry({
		monitor,
		refresh,
	}: {
		monitor: monitor_configuration
		refresh: () => Promise<void>
	}) {
		let pending = false
		const click = async () => {
			if (pending) return
			pending = true
			try {
				await toggle_mirror(monitor.name, refresh)
			} finally {
				pending = false
			}
		}
		const mirrored = is_mirrored(monitor) ? "(Mirrored)" : ""
		return (
			<button onClicked={() => void click()}>
				<box class="mirror-item horizontal">
					<image iconName={icons.ui.projector} pixelSize={scaled(16)} />
					<label label={`${monitor.model} (${monitor.name}) ${mirrored}`} />
				</box>
			</button>
		)
	}
}
