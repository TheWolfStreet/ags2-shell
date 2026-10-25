import GObject, { getter, register } from "ags/gobject"
import { monitorFile, readFileAsync } from "ags/file"
import { debounce, idle, timeout, type timer } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import {
	attempt,
	attempt_async,
	err,
	log_error,
	ok,
	type result,
	unwrap_or,
} from "$lib/result"
import { hyprland } from "$lib/hyprland"
import { run_command } from "$lib/commands"

type ddc_display = { maximum: number; applied: number | null }
type display_scan = {
	displays: Map<number, ddc_display>
	first_value: number | null
	read_failed: boolean
}

type pending_write = {
	target: number
	resolve: (result: result<"applied" | "superseded">) => void
}

const display_write_debounce_ms = 10
const external_refresh_debounce_ms = 60

export function parse_ddc_brightness(
	raw: string,
): { current: number; maximum: number } | null {
	const match = raw.match(/^VCP\s+10\s+C\s+(\d+)\s+(\d+)\s*$/im)
	if (!match) return null
	const current = Number(match[1])
	const maximum = Number(match[2])
	if (!Number.isSafeInteger(current) || !Number.isSafeInteger(maximum))
		return null
	if (maximum <= 0 || current < 0 || current > maximum) return null
	return { current, maximum }
}

function has_ddcutil() {
	return GLib.find_program_in_path("ddcutil") !== null
}

function clamp01(value: number) {
	return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

export function brightness_target(percent: number, maximum = 100): number {
	return Math.round(clamp01(percent) * maximum)
}

function list_children(directory: string): string[] {
	const enumerator = Gio.File.new_for_path(directory).enumerate_children(
		"standard::name",
		Gio.FileQueryInfoFlags.NONE,
		null,
	)
	const names: string[] = []
	try {
		while (true) {
			const info = enumerator.next_file(null)
			if (!info) break
			names.push(info.get_name())
		}
	} finally {
		enumerator.close(null)
	}
	return names
}

function first_sysfs_device(
	directory: string,
	filter: (name: string) => boolean = () => true,
): string {
	const found = attempt(
		() => list_children(directory).filter(filter).sort()[0] ?? "",
	)
	return unwrap_or(
		found,
		"",
		`brightness.devices: Failed to enumerate ${directory}`,
	)
}

async function read_sysfs_level(
	base: string,
): Promise<result<{ max: number; current: number }>> {
	const read = await attempt_async(() =>
		Promise.all([
			readFileAsync(`${base}/max_brightness`).then(Number),
			readFileAsync(`${base}/brightness`).then(Number),
		]),
	)
	if (!read.ok) return read

	const [max, current] = read.value
	if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(current))
		return err(new Error(`Invalid brightness from ${base}`))
	return ok({ max, current })
}

let ddc_work: Promise<void> = Promise.resolve()
function run_ddc(args: string[]): Promise<result<string>> {
	const work = ddc_work.then(() =>
		run_command(["ddcutil", ...args], { timeout_ms: 20_000 }),
	)
	ddc_work = work.then(() => undefined)
	return work
}

function external_display(block: string): number | null {
	const display = block.match(/^Display\s+(\d+)/m)
	if (!display) return null
	const connector =
		block.match(/DRM connector:\s+([^\n]+)/i)?.[1]?.toLowerCase() ?? ""
	if (connector.includes("edp") || connector.includes("lvds")) return null
	return Number(display[1])
}

async function discover_ddc_displays(): Promise<result<number[]>> {
	const detected = await run_ddc(["detect"])
	if (!detected.ok) return detected

	const displays: number[] = []
	for (const block of detected.value.split(/\n\s*\n/)) {
		const display = external_display(block.trim())
		if (display !== null) displays.push(display)
	}
	return ok(displays)
}

async function read_ddc_brightness(
	display: number,
): Promise<result<{ current: number; maximum: number }>> {
	const read = await run_ddc([
		"getvcp",
		"10",
		"--brief",
		"--display",
		String(display),
	])
	if (!read.ok) return read
	const parsed = parse_ddc_brightness(read.value)
	if (parsed) return ok(parsed)
	return err(
		new Error(`Invalid DDC brightness for display ${display}: ${read.value}`),
	)
}

async function read_device(
	path: string,
	kind: string,
	apply: (raw: string) => void,
) {
	const read = await attempt_async(async () => apply(await readFileAsync(path)))
	log_error(read, `brightness.monitor: Failed to read ${kind} brightness`)
}

@register()
class Brightness extends GObject.Object {
	declare static $gtype: GObject.GType<Brightness>

	#display_device = ""
	#keyboard_device = ""

	#display_max = 1
	#display_value = 0
	#display_available = false
	#external_displays = new Map<number, ddc_display>()

	#keyboard_max = 0
	#keyboard_value = 0

	#hyprland_signal_ids: number[] = []
	#device_monitors: Gio.FileMonitor[] = []
	#external_discovery_idle: timer | null = null
	#discovery_retry: timer | null = null
	#retries = 0

	#display_write = debounce(display_write_debounce_ms, () =>
		this.#flush_display_writes(),
	)
	#refresh_external = debounce(external_refresh_debounce_ms, () =>
		this.#refresh_external_displays(),
	)
	#display_write_in_flight = false
	#queued_display_target: number | null = null
	#pending_writes: pending_write[] = []
	#internal_applied: number | null = null
	#discovery_revision = 0
	#discovery_running = false
	#discovery_requested = false
	#refresh_after_write = false
	#finished = false
	#initialized = false

	constructor() {
		super()
		void this.#init()
	}

	async #init() {
		const result = await attempt_async(async () => {
			this.#load_devices()
			await this.#load_initial_values()
			this.notify("display")
			this.notify("kbd")
			this.#watch_devices()
			this.#watch_hotplug()
		})
		log_error(
			result,
			"brightness.init: Failed to initialize brightness service",
		)
		if (this.#display_device || this.#keyboard_device) this.#initialized = true
		if (has_ddcutil())
			this.#external_discovery_idle = idle(() => {
				this.#external_discovery_idle = null
				void this.#refresh_external_displays()
			})
	}

	get initialized() {
		return this.#initialized
	}

	#load_devices() {
		this.#display_device = first_sysfs_device("/sys/class/backlight")
		this.#keyboard_device = first_sysfs_device("/sys/class/leds", (name) =>
			/(?:kbd_backlight|keyboard.*backlight)/i.test(name),
		)
		this.#update_display_available()
	}

	async #load_initial_values() {
		const [keyboard, display] = await Promise.all([
			this.#load_keyboard_value(),
			this.#load_display_value(),
		])
		if (!keyboard.ok) {
			this.#keyboard_device = ""
			console.error(
				"brightness.init: Failed to read keyboard brightness",
				keyboard.err,
			)
		}
		if (!display.ok) {
			this.#display_device = ""
			this.#update_display_available()
			console.error(
				"brightness.init: Failed to read display brightness",
				display.err,
			)
		}
	}

	async #load_keyboard_value(): Promise<result<void>> {
		if (!this.#keyboard_device) return ok(undefined)
		const level = await read_sysfs_level(
			`/sys/class/leds/${this.#keyboard_device}`,
		)
		if (!level.ok) return level

		this.#keyboard_max = level.value.max
		this.#keyboard_value = clamp01(level.value.current / level.value.max)
		return ok(undefined)
	}

	async #load_display_value(): Promise<result<void>> {
		if (!this.#display_device) return ok(undefined)
		const level = await read_sysfs_level(
			`/sys/class/backlight/${this.#display_device}`,
		)
		if (!level.ok) return level

		this.#display_max = level.value.max
		this.#display_value = clamp01(level.value.current / this.#display_max)
		this.#internal_applied = Math.round(this.#display_value * 100)
		return ok(undefined)
	}

	#watch_devices() {
		if (this.#display_device)
			this.#watch_device(
				`/sys/class/backlight/${this.#display_device}/brightness`,
				"display",
				(raw) => this.#set_display_from_raw(Number(raw)),
			)
		if (this.#keyboard_device)
			this.#watch_device(
				`/sys/class/leds/${this.#keyboard_device}/brightness`,
				"keyboard",
				(raw) => this.#set_keyboard_from_raw(Number(raw)),
			)
	}

	#watch_device(path: string, kind: string, apply: (raw: string) => void) {
		const monitored = attempt(() =>
			monitorFile(path, (changed) => void read_device(changed, kind, apply)),
		)
		if (log_error(monitored, `brightness.monitor: Failed to watch ${kind}`))
			this.#device_monitors.push(monitored.value)
	}

	#write_pending() {
		return this.#queued_display_target !== null || this.#display_write_in_flight
	}

	#show_display_value(value: number) {
		if (value === this.#display_value) return
		this.#display_value = value
		this.notify("display")
	}

	#set_display_from_raw(raw: number) {
		const next = clamp01(raw / this.#display_max)
		this.#internal_applied = Math.round(next * 100)
		if (this.#write_pending()) return
		this.#show_display_value(next)
	}

	#set_keyboard_from_raw(raw: number) {
		if (!Number.isFinite(raw)) return

		const next = this.#keyboard_max ? clamp01(raw / this.#keyboard_max) : 0
		if (next === this.#keyboard_value) return

		this.#keyboard_value = next
		this.notify("kbd")
	}

	#watch_hotplug() {
		if (!has_ddcutil()) return
		const watched = attempt(() => {
			for (const signal of ["monitor-added", "monitor-removed"])
				this.#hyprland_signal_ids.push(
					hyprland.connect(signal, () => this.#refresh_external.call()),
				)
		})
		log_error(
			watched,
			"brightness.watch_hotplug: Failed to watch display hotplug",
		)
	}

	#has_display_control() {
		return this.#display_device.length > 0 || this.#external_displays.size > 0
	}

	#update_display_available() {
		const next = this.#has_display_control()
		if (next === this.#display_available) return

		this.#display_available = next
		this.notify("display-available")
	}

	async #refresh_external_displays() {
		if (!has_ddcutil() || this.#finished) return
		if (this.#discovery_running) {
			this.#discovery_requested = true
			return
		}
		this.#discovery_running = true
		try {
			do {
				this.#discovery_requested = false
				await this.#discover_external_displays()
			} while (this.#discovery_requested && !this.#finished)
		} finally {
			this.#discovery_running = false
		}
	}

	#discovery_stale(revision: number) {
		if (this.#finished || this.#discovery_requested) return true
		return revision !== this.#discovery_revision
	}

	#defer_until_written() {
		if (!this.#display_write_in_flight) return false
		this.#refresh_after_write = true
		return true
	}

	async #discover_external_displays() {
		if (this.#defer_until_written()) return
		const revision = ++this.#discovery_revision
		const discovered = await discover_ddc_displays()
		if (this.#discovery_stale(revision)) return
		if (
			!log_error(
				discovered,
				"brightness.ddc.detect: Failed to detect external displays",
			)
		) {
			this.#retry_discovery()
			return
		}
		const scan = await this.#scan_displays(discovered.value, revision)
		if (!scan || this.#discovery_requested) return
		if (this.#defer_until_written()) return
		this.#track_retry(scan.read_failed)
		this.#adopt_displays(scan)
	}

	async #scan_displays(
		displays: number[],
		revision: number,
	): Promise<display_scan | null> {
		const scan: display_scan = {
			displays: new Map(),
			first_value: null,
			read_failed: false,
		}
		for (const display of new Set(displays)) {
			const read = await read_ddc_brightness(display)
			if (this.#discovery_stale(revision)) return null
			if (
				!log_error(
					read,
					`brightness.ddc.read: Failed to read display ${display}`,
				)
			) {
				scan.read_failed = true
				const previous = this.#external_displays.get(display)
				if (previous) scan.displays.set(display, previous)
				continue
			}
			const fraction = read.value.current / read.value.maximum
			scan.displays.set(display, {
				maximum: read.value.maximum,
				applied: brightness_target(fraction),
			})
			scan.first_value ??= fraction
		}
		return scan
	}

	#track_retry(read_failed: boolean) {
		if (read_failed) {
			this.#retry_discovery()
			return
		}
		this.#retries = 0
		this.#discovery_retry?.cancel()
		this.#discovery_retry = null
	}

	#adopt_displays({ displays, first_value }: display_scan) {
		const previously_available = this.#display_available
		this.#external_displays = displays
		if (displays.size > 0) this.#initialized = true
		this.#update_display_available()
		if (this.#display_device || previously_available) return
		if (first_value === null || this.#write_pending()) return
		this.#show_display_value(clamp01(first_value))
	}

	#retry_discovery() {
		if (this.#discovery_retry || this.#retries >= 3 || this.#finished) return
		const delay = 5000 * 3 ** this.#retries++
		this.#discovery_retry = timeout(delay, () => {
			this.#discovery_retry = null
			void this.#refresh_external_displays()
		})
	}

	async #flush_display_writes() {
		if (this.#display_write_in_flight) return

		const target = this.#queued_display_target
		if (target === null) return

		this.#queued_display_target = null
		this.#display_write_in_flight = true
		try {
			this.#settle_writes(target, await this.#apply_display_brightness(target))
		} finally {
			this.#display_write_in_flight = false
			this.#continue_after_write()
		}
	}

	#settle_writes(target: number, applied: result<void>) {
		const outcome = applied.ok ? ok("applied" as const) : applied
		for (const pending of this.#pending_writes)
			if (pending.target === target) pending.resolve(outcome)
		this.#pending_writes = this.#pending_writes.filter(
			(pending) => pending.target !== target,
		)
	}

	#continue_after_write() {
		if (this.#finished) return
		if (this.#refresh_after_write) {
			this.#refresh_after_write = false
			this.#refresh_external.call()
		}
		if (this.#queued_display_target !== null) void this.#flush_display_writes()
	}

	async #apply_display_brightness(target: number): Promise<result<void>> {
		const controlled = this.#has_display_control()
		const failures: unknown[] = []
		const internal = await this.#write_internal(target)
		if (!internal.ok) failures.push(internal.err)
		for (const [display, state] of this.#external_displays) {
			const external = await this.#write_external(display, state, target)
			if (!external.ok) failures.push(external.err)
		}
		if (this.#queued_display_target === null && this.#unapplied(target))
			this.#show_applied_value()
		if (!controlled)
			return err(new Error("No brightness devices are available"))
		if (failures.length === 0) return ok(undefined)
		return err(
			new Error(
				`Brightness ${target}% failed on ${failures.length} device(s)`,
				{ cause: failures },
			),
		)
	}

	async #write_internal(target: number): Promise<result<unknown>> {
		if (!this.#display_device || this.#internal_applied === target)
			return ok(undefined)
		const written = await run_command([
			"brightnessctl",
			"-d",
			this.#display_device,
			"set",
			`${target}%`,
			"-q",
		])
		log_error(
			written,
			"brightness.write: Failed to set internal display brightness",
		)
		if (written.ok) this.#internal_applied = target
		return written
	}

	async #write_external(
		display: number,
		state: ddc_display,
		target: number,
	): Promise<result<unknown>> {
		if (state.applied === target) return ok(undefined)
		const written = await run_ddc([
			"setvcp",
			"10",
			String(brightness_target(target / 100, state.maximum)),
			"--display",
			String(display),
			"--noverify",
		])
		log_error(
			written,
			`brightness.ddc.write: Failed to set display ${display} to ${target}%`,
		)
		if (written.ok) state.applied = target
		return written
	}

	#unapplied(target: number) {
		if (this.#display_device && this.#internal_applied !== target) return true
		return [...this.#external_displays.values()].some(
			(display) => display.applied !== target,
		)
	}

	#show_applied_value() {
		const actual = this.#display_device
			? this.#internal_applied
			: this.#external_displays.values().next().value?.applied
		if (actual == null) return
		this.#display_value = actual / 100
		this.notify("display")
	}

	@getter(Number)
	get kbd() {
		return this.#keyboard_value
	}

	@getter(Number)
	get display() {
		return this.#display_value
	}

	set_display(percent: number): Promise<result<"applied" | "superseded">> {
		if (!this.#display_available || !this.#initialized)
			return Promise.resolve(
				err(new Error("No initialized brightness device is available")),
			)

		const value = clamp01(percent)
		const target = brightness_target(value)

		for (const pending of this.#pending_writes)
			pending.resolve(ok("superseded"))
		this.#pending_writes = []
		const result = new Promise<result<"applied" | "superseded">>((resolve) => {
			this.#pending_writes.push({ target, resolve })
		})
		this.#queued_display_target = target
		this.#display_write.call()
		this.#show_display_value(value)
		return result
	}

	@getter(Boolean)
	get displayAvailable() {
		return this.#display_available
	}

	vfunc_finalize() {
		this.#finished = true
		for (const pending of this.#pending_writes)
			pending.resolve(err(new Error("Brightness service stopped")))
		this.#pending_writes = []
		this.#discovery_revision++
		this.#external_discovery_idle?.cancel()
		this.#discovery_retry?.cancel()
		this.#external_discovery_idle = null
		this.#display_write.cancel()
		this.#refresh_external.cancel()

		for (const id of this.#hyprland_signal_ids) hyprland.disconnect(id)
		this.#hyprland_signal_ids = []
		for (const monitor of this.#device_monitors) monitor.cancel()
		this.#device_monitors = []

		super.vfunc_finalize()
	}
}

export const brightness = new Brightness()
