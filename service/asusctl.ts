import GObject, { getter, register } from "ags/gobject"

import { hyprland } from "$lib/hyprland"
import GLib from "gi://GLib"
import { attempt, attempt_async, err, ok, type Result } from "$lib/result"
import options from "$shell/options"
import {
	format_monitor_command,
	type monitor_settings,
} from "./monitorConfiguration"
import { run_command } from "./commands"

type monitor_configuration = monitor_settings & {
	disabled: boolean
	availableModes?: string[]
}

type monitor_mode = {
	resolution: string
	refresh_rate: number
}

function parse_profile(raw: string): Result<Asusctl.Profile> {
	const value = raw.trim()
	if (value === "Performance" || value === "Balanced" || value === "Quiet")
		return ok(value)

	return err(new Error(`Unexpected profile value: ${value}`))
}

function parse_mode(raw: string): Result<Asusctl.Mode> {
	const value = raw.trim()
	if (value === "Hybrid" || value === "Integrated") return ok(value)

	return err(new Error(`Unexpected mode value: ${value}`))
}

function is_record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function parse_monitor_mode(mode: string): monitor_mode | null {
	const match = mode.match(/^(\d+)x(\d+)\s*@\s*([0-9]+(?:\.[0-9]+)?)/)
	if (!match) return null

	const refresh_rate = Number.parseFloat(match[3])
	return Number.isFinite(refresh_rate) && refresh_rate > 0
		? { resolution: `${match[1]}x${match[2]}`, refresh_rate }
		: null
}

function is_internal_panel(name: string) {
	return /^(?:eDP|LVDS)-/i.test(name)
}

function select_panel(
	monitors: monitor_configuration[],
): monitor_configuration | undefined {
	return monitors.find((monitor) => is_internal_panel(monitor.name))
}

function parse_panel_modes(modes: string[]): monitor_mode[] {
	return modes
		.map(parse_monitor_mode)
		.filter((mode): mode is monitor_mode => mode !== null)
}

function get_panel_modes(configuration: monitor_configuration): monitor_mode[] {
	const resolution = `${configuration.width}x${configuration.height}`
	return parse_panel_modes(configuration.availableModes ?? []).filter(
		(mode) => mode.resolution === resolution,
	)
}

function unique_refresh_rates(modes: monitor_mode[]): number[] {
	return [...new Set(modes.map((mode) => Math.round(mode.refresh_rate)))].sort(
		(a, b) => a - b,
	)
}

function nearest_value(values: number[], preferred: number): number {
	return values.reduce((nearest, value) =>
		Math.abs(value - preferred) < Math.abs(nearest - preferred)
			? value
			: nearest,
	)
}

function normalize_refresh_rate(value: number, available: number[]): number {
	if (available.includes(value)) return value
	return nearest_value(available, value)
}

function resolve_refresh_rate(
	modes: monitor_mode[],
	preferred: number,
): number {
	const available = modes.map((mode) => mode.refresh_rate)
	return nearest_value(available, preferred)
}

function is_monitor_configuration(
	value: unknown,
): value is monitor_configuration {
	if (!is_record(value)) return false

	return (
		typeof value.name === "string" &&
		typeof value.disabled === "boolean" &&
		typeof value.width === "number" &&
		value.width > 0 &&
		typeof value.height === "number" &&
		value.height > 0 &&
		typeof value.x === "number" &&
		Number.isFinite(value.x) &&
		typeof value.y === "number" &&
		Number.isFinite(value.y) &&
		typeof value.scale === "number" &&
		value.scale > 0 &&
		Number.isFinite(value.scale) &&
		typeof value.refreshRate === "number" &&
		Number.isFinite(value.refreshRate) &&
		typeof value.transform === "number" &&
		Number.isInteger(value.transform) &&
		(value.availableModes === undefined ||
			(Array.isArray(value.availableModes) &&
				value.availableModes.every((mode) => typeof mode === "string")))
	)
}

const profile_values: Asusctl.Profile[] = ["Performance", "Balanced", "Quiet"]

namespace Asusctl {
	export type Profile = "Performance" | "Balanced" | "Quiet"
	export type Mode = "Hybrid" | "Integrated"
}

@register()
class Asusctl extends GObject.Object {
	declare static $gtype: GObject.GType<Asusctl>

	#profile: Asusctl.Profile
	#mode: Asusctl.Mode
	#available: boolean
	#installed: boolean
	#option_disposers: Array<() => void>
	#monitor_update_sequence: number
	#observed_sequence = 0
	#observed_panel: monitor_configuration | undefined
	#policy_sequence = 0
	#profile_write: Promise<void> = Promise.resolve()
	#profile_revision = 0
	#refresh_rates: number[] = []
	#monitor_handlers: number[] = []

	constructor() {
		super()

		this.#profile = "Balanced"
		this.#mode = "Hybrid"
		this.#installed = GLib.find_program_in_path("asusctl") !== null
		this.#available = false
		this.#option_disposers = []
		this.#monitor_update_sequence = 0

		if (this.#installed) {
			void this.refresh().then((result) => {
				if (!result.ok) console.error("asusctl.initialize:", result.err)
				else void this.#update_monitor_configuration()
			})
			this.#option_disposers.push(
				options.asus.ac_hz.subscribe(
					() => void this.#update_monitor_configuration(),
				),
				options.asus.bat_hz.subscribe(
					() => void this.#update_monitor_configuration(),
				),
			)
			for (const signal of [
				"monitor-added",
				"monitor-removed",
				"config-reloaded",
			]) {
				this.#monitor_handlers.push(
					hyprland.connect(
						signal,
						() =>
							void this.#update_monitor_configuration({ apply_policy: false }),
					),
				)
			}
		}
	}

	get profiles(): Asusctl.Profile[] {
		return [...profile_values]
	}

	@getter(Array)
	get refreshRates(): number[] {
		return this.#refresh_rates
	}

	@getter(String)
	get profile(): string {
		return this.#profile
	}

	@getter(String)
	get mode(): string {
		return this.#mode
	}

	@getter(Boolean)
	get available(): boolean {
		return this.#available
	}

	#set_available(available: boolean) {
		if (this.#available === available) return
		this.#available = available
		this.notify("available")
	}

	async set_profile(value: string): Promise<Result<void>> {
		if (!this.#installed) return err(new Error("asusctl is unavailable"))
		const parsed = parse_profile(value)
		if (!parsed.ok) return parsed
		this.#profile_revision++
		let response: Result<void> = ok(undefined)
		const write = this.#profile_write.then(async () => {
			const result = await run_command([
				"asusctl",
				"profile",
				"set",
				parsed.value,
			])
			if (!result.ok) {
				response = result
				return
			}
			this.#profile = parsed.value
			this.#set_available(true)
			this.notify("profile")
			await this.#update_monitor_configuration()
		})
		this.#profile_write = write.then(
			() => undefined,
			() => undefined,
		)
		const completed = await attempt_async(() => write)
		return completed.ok ? response : completed
	}

	async #update_monitor_configuration({
		apply_policy = true,
	}: { apply_policy?: boolean } = {}) {
		if (!this.#available) return
		const sequence = ++this.#monitor_update_sequence
		const policy_sequence = apply_policy
			? ++this.#policy_sequence
			: this.#policy_sequence
		const output = await run_command(["hyprctl", "monitors", "all", "-j"])
		if (sequence !== this.#monitor_update_sequence && !apply_policy) return
		if (!output.ok) {
			console.error(
				"asusctl.updateMonitorConfiguration: Failed to read monitors",
				output.err,
			)
			return
		}

		const parse_result = attempt((): unknown => JSON.parse(output.value))
		if (!parse_result.ok) {
			console.error(
				"asusctl.updateMonitorConfiguration: Failed to parse monitors",
				parse_result.err,
			)
			return
		}
		const parsed = parse_result.value
		if (!Array.isArray(parsed)) return

		const panel = select_panel(parsed.filter(is_monitor_configuration))
		if (sequence === this.#monitor_update_sequence) {
			this.#observed_panel = panel
			this.#observed_sequence = sequence
			const observed_modes =
				panel && !panel.disabled ? get_panel_modes(panel) : []
			const available_refresh_rates = unique_refresh_rates(observed_modes)
			if (available_refresh_rates.join(",") !== this.#refresh_rates.join(",")) {
				this.#refresh_rates = available_refresh_rates
				this.notify("refresh-rates")
			}
		}
		if (!apply_policy || policy_sequence !== this.#policy_sequence) return
		const policy_panel =
			this.#observed_sequence > sequence ? this.#observed_panel : panel
		const panel_modes =
			policy_panel && !policy_panel.disabled
				? get_panel_modes(policy_panel)
				: []
		const available_refresh_rates = unique_refresh_rates(panel_modes)
		if (
			!policy_panel ||
			policy_panel.disabled ||
			available_refresh_rates.length === 0
		)
			return
		const ac_hz = normalize_refresh_rate(
			options.asus.ac_hz.peek(),
			available_refresh_rates,
		)
		const bat_hz = normalize_refresh_rate(
			options.asus.bat_hz.peek(),
			available_refresh_rates,
		)

		if (ac_hz !== options.asus.ac_hz.peek()) options.asus.ac_hz.set(ac_hz)
		if (bat_hz !== options.asus.bat_hz.peek()) options.asus.bat_hz.set(bat_hz)
		if (policy_sequence !== this.#policy_sequence) return

		const preferred_refresh_rate = this.#profile === "Quiet" ? bat_hz : ac_hz
		const refresh_rate = resolve_refresh_rate(
			panel_modes,
			preferred_refresh_rate,
		)
		if (Math.abs(policy_panel.refreshRate - refresh_rate) < 0.1) return
		const response = await attempt_async(() =>
			hyprland.message_async(
				format_monitor_command(policy_panel, { refresh_rate: refresh_rate }),
			),
		)
		if (policy_sequence !== this.#policy_sequence) return
		if (!response.ok || response.value !== "ok")
			console.error(
				"asusctl.monitor: Failed to apply refresh rate",
				response.ok ? response.value : response.err,
			)
	}

	async refresh(): Promise<Result<void>> {
		if (!this.#installed) return err(new Error("asusctl is unavailable"))
		const revision = this.#profile_revision
		const profile_output = await run_command(["asusctl", "profile", "get"])
		if (!profile_output.ok) {
			this.#set_available(false)
			return profile_output
		}

		const match = profile_output.value.match(/Active profile: (\w+)/)
		const profile = parse_profile(match?.[1] ?? "")
		if (!profile.ok) {
			this.#set_available(false)
			return profile
		}
		this.#set_available(true)

		if (
			revision === this.#profile_revision &&
			this.#profile !== profile.value
		) {
			this.#profile = profile.value
			this.notify("profile")
		}

		if (GLib.find_program_in_path("supergfxctl") !== null) {
			const mode_output = await run_command(["supergfxctl", "-g"])
			if (!mode_output.ok) {
				console.error(
					"asusctl.initialize: Failed to read mode",
					mode_output.err,
				)
			} else {
				const mode = parse_mode(mode_output.value)
				if (!mode.ok) {
					console.error("asusctl.initialize: Failed to parse mode", mode.err)
				} else {
					if (this.#mode !== mode.value) {
						this.#mode = mode.value
						this.notify("mode")
					}
				}
			}
		}

		return ok(undefined)
	}

	vfunc_finalize() {
		for (const dispose of this.#option_disposers) dispose()
		this.#option_disposers = []
		for (const handler of this.#monitor_handlers) hyprland.disconnect(handler)
		this.#monitor_handlers = []
		super.vfunc_finalize()
	}
}

export const asusctl = new Asusctl()
