import GObject, { getter, register } from "ags/gobject"

import { hyprland, hyprland_command } from "$lib/hyprland"
import GLib from "gi://GLib"
import {
	attempt,
	attempt_async,
	err,
	log_error,
	ok,
	type result,
} from "$lib/result"
import options, { type Opt } from "$shell/options"
import {
	format_monitor_command,
	is_monitor_settings,
	type monitor_settings,
} from "./monitor_configuration"
import { run_command } from "$lib/commands"

type monitor_configuration = monitor_settings & {
	disabled: boolean
	availableModes?: string[]
}

type monitor_mode = {
	resolution: string
	refresh_rate: number
}

const asus_profiles = ["Performance", "Balanced", "Quiet"] as const
const asus_modes = ["Hybrid", "Integrated"] as const
const monitor_signals = ["monitor-added", "monitor-removed", "config-reloaded"]
type asus_profile = (typeof asus_profiles)[number]
type asus_mode = (typeof asus_modes)[number]

function parse_choice<T extends string>(
	raw: string,
	choices: readonly T[],
	kind: string,
): result<T> {
	const value = raw.trim()
	const match = choices.find((choice) => choice === value)
	if (match) return ok(match)
	return err(new Error(`Unexpected ${kind} value: ${value}`))
}

function parse_monitor_mode(mode: string): monitor_mode | null {
	const match = mode.match(/^(\d+)x(\d+)\s*@\s*([0-9]+(?:\.[0-9]+)?)/)
	if (!match) return null
	const refresh_rate = Number.parseFloat(match[3])
	if (!Number.isFinite(refresh_rate) || refresh_rate <= 0) return null
	return { resolution: `${match[1]}x${match[2]}`, refresh_rate }
}

function find_internal_panel(
	monitors: monitor_configuration[],
): monitor_configuration | undefined {
	return monitors.find((monitor) => /^(?:eDP|LVDS)-/i.test(monitor.name))
}

function panel_modes(panel: monitor_configuration | undefined): monitor_mode[] {
	if (!panel || panel.disabled) return []
	const resolution = `${panel.width}x${panel.height}`
	return (panel.availableModes ?? [])
		.map(parse_monitor_mode)
		.filter((mode): mode is monitor_mode => mode !== null)
		.filter((mode) => mode.resolution === resolution)
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

function is_mode_list(modes: unknown): boolean {
	if (modes === undefined) return true
	return Array.isArray(modes) && modes.every((mode) => typeof mode === "string")
}

function is_monitor_configuration(
	value: unknown,
): value is monitor_configuration {
	if (!is_monitor_settings(value)) return false
	const details = value as { disabled?: unknown; availableModes?: unknown }
	if (typeof details.disabled !== "boolean") return false
	if (value.width <= 0 || value.height <= 0 || value.scale <= 0) return false
	if (!Number.isInteger(value.transform)) return false
	return is_mode_list(details.availableModes)
}

function read_monitor_list(output: result<string>): unknown[] | null {
	if (
		!log_error(
			output,
			"asusctl.update_monitor_configuration: Failed to read monitors",
		)
	)
		return null
	const parsed = attempt((): unknown => JSON.parse(output.value))
	if (
		!log_error(
			parsed,
			"asusctl.update_monitor_configuration: Failed to parse monitors",
		)
	)
		return null
	if (!Array.isArray(parsed.value)) return null
	return parsed.value
}

async function read_profile(): Promise<result<asus_profile>> {
	const output = await run_command(["asusctl", "profile", "get"])
	if (!output.ok) return output
	const match = output.value.match(/Active profile: (\w+)/)
	return parse_choice(match?.[1] ?? "", asus_profiles, "profile")
}

function set_if_changed(option: Opt<number>, value: number) {
	if (value !== option.peek()) option.set(value)
}

@register()
class Asusctl extends GObject.Object {
	declare static $gtype: GObject.GType<Asusctl>

	#installed = GLib.find_program_in_path("asusctl") !== null
	#profile: asus_profile = "Balanced"
	#mode: asus_mode = "Hybrid"
	#available = false
	#option_disposers: (() => void)[] = []
	#monitor_handlers: number[] = []
	#monitor_update_sequence = 0
	#observed_sequence = 0
	#observed_panel: monitor_configuration | undefined
	#policy_sequence = 0
	#profile_write: Promise<void> = Promise.resolve()
	#profile_revision = 0
	#refresh_rates: number[] = []

	constructor() {
		super()
		if (!this.#installed) return
		void this.#initialize()
		const apply_policy = () => void this.#update_monitor_configuration()
		this.#option_disposers.push(
			options.asus.ac_hz.subscribe(apply_policy),
			options.asus.bat_hz.subscribe(apply_policy),
		)
		for (const signal of monitor_signals)
			this.#monitor_handlers.push(
				hyprland.connect(
					signal,
					() =>
						void this.#update_monitor_configuration({ apply_policy: false }),
				),
			)
	}

	get profiles(): asus_profile[] {
		return [...asus_profiles]
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

	async #initialize() {
		const refreshed = await this.refresh()
		if (!log_error(refreshed, "asusctl.initialize:")) return
		await this.#update_monitor_configuration()
	}

	#set_available(available: boolean) {
		if (this.#available === available) return
		this.#available = available
		this.notify("available")
	}

	async set_profile(value: string): Promise<result<void>> {
		if (!this.#installed) return err(new Error("asusctl is unavailable"))
		const parsed = parse_choice(value, asus_profiles, "profile")
		if (!parsed.ok) return parsed
		this.#profile_revision++
		const write = this.#profile_write.then(() =>
			this.#write_profile(parsed.value),
		)
		this.#profile_write = write.then(
			() => undefined,
			() => undefined,
		)
		const completed = await attempt_async(() => write)
		if (!completed.ok) return completed
		return completed.value
	}

	async #write_profile(profile: asus_profile): Promise<result<void>> {
		const written = await run_command(["asusctl", "profile", "set", profile])
		if (!written.ok) return written
		this.#profile = profile
		this.#set_available(true)
		this.notify("profile")
		await this.#update_monitor_configuration()
		return ok(undefined)
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
		const monitors = read_monitor_list(output)
		if (!monitors) return

		const panel = find_internal_panel(monitors.filter(is_monitor_configuration))
		if (sequence === this.#monitor_update_sequence)
			this.#observe_panel(panel, sequence)
		if (!apply_policy || policy_sequence !== this.#policy_sequence) return
		const newest =
			this.#observed_sequence > sequence ? this.#observed_panel : panel
		await this.#apply_refresh_policy(newest, policy_sequence)
	}

	#observe_panel(panel: monitor_configuration | undefined, sequence: number) {
		this.#observed_panel = panel
		this.#observed_sequence = sequence
		const refresh_rates = unique_refresh_rates(panel_modes(panel))
		if (refresh_rates.join(",") === this.#refresh_rates.join(",")) return
		this.#refresh_rates = refresh_rates
		this.notify("refresh-rates")
	}

	async #apply_refresh_policy(
		panel: monitor_configuration | undefined,
		policy_sequence: number,
	) {
		const modes = panel_modes(panel)
		const refresh_rates = unique_refresh_rates(modes)
		if (!panel || refresh_rates.length === 0) return
		const ac_hz = nearest_value(refresh_rates, options.asus.ac_hz.peek())
		const bat_hz = nearest_value(refresh_rates, options.asus.bat_hz.peek())
		set_if_changed(options.asus.ac_hz, ac_hz)
		set_if_changed(options.asus.bat_hz, bat_hz)
		if (policy_sequence !== this.#policy_sequence) return

		const preferred = this.#profile === "Quiet" ? bat_hz : ac_hz
		const refresh_rate = nearest_value(
			modes.map((mode) => mode.refresh_rate),
			preferred,
		)
		if (Math.abs(panel.refreshRate - refresh_rate) < 0.1) return
		const response = await hyprland_command(
			format_monitor_command(panel, { refresh_rate }),
		)
		if (policy_sequence !== this.#policy_sequence) return
		log_error(response, "asusctl.monitor: Failed to apply refresh rate")
	}

	async refresh(): Promise<result<void>> {
		if (!this.#installed) return err(new Error("asusctl is unavailable"))
		const revision = this.#profile_revision
		const profile = await read_profile()
		this.#set_available(profile.ok)
		if (!profile.ok) return profile
		if (
			revision === this.#profile_revision &&
			this.#profile !== profile.value
		) {
			this.#profile = profile.value
			this.notify("profile")
		}
		await this.#refresh_mode()
		return ok(undefined)
	}

	async #refresh_mode() {
		if (GLib.find_program_in_path("supergfxctl") === null) return
		const output = await run_command(["supergfxctl", "-g"])
		if (!log_error(output, "asusctl.initialize: Failed to read mode")) return
		const mode = parse_choice(output.value, asus_modes, "mode")
		if (!log_error(mode, "asusctl.initialize: Failed to parse mode")) return
		if (this.#mode === mode.value) return
		this.#mode = mode.value
		this.notify("mode")
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
