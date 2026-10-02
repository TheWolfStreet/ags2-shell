import GObject, { getter, register } from "ags/gobject"
import { monitorFile, readFileAsync } from "ags/file"
import { execAsync } from "ags/process"
import { idle, timeout, type Timer } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt, attempt_async, err, log_error, ok, type Result } from "$lib/result"
import { debounce } from "$lib/time"
import { hyprland } from "$lib/hyprland"
import { brightness_target, parse_ddc_brightness } from "./brightnessMath"
import { run_command } from "./commands"

function first_sysfs_device(directory: string, filter: (name: string) => boolean = () => true): string {
	const result = attempt(() => {
		const enumerator = Gio.File.new_for_path(directory).enumerate_children(
			"standard::name",
			Gio.FileQueryInfoFlags.NONE,
			null,
		)
		const names: string[] = []
		try {
			let info: Gio.FileInfo | null
			while ((info = enumerator.next_file(null)) !== null)
				if (filter(info.get_name())) names.push(info.get_name())
		} finally {
			enumerator.close(null)
		}
		return names.sort()[0] ?? ""
	})
	return result.ok ? result.value : ""
}

let ddc_work: Promise<void> = Promise.resolve()
function run_ddc(args: string[]): Promise<Result<string>> {
	const work = ddc_work.then(() => run_command(["ddcutil", ...args], { timeout_ms: 20_000 }))
	ddc_work = work.then(() => undefined)
	return work
}

async function discover_ddc_displays(): Promise<Result<number[]>> {
	const result = await run_ddc(["detect"])
	if (!result.ok) return result

	const displays: number[] = []
	for (const block of result.value
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter(Boolean)) {
		const display_match = block.match(/^Display\s+(\d+)/m)
		if (!display_match) continue

		const connector =
			block.match(/DRM connector:\s+([^\n]+)/i)?.[1]?.toLowerCase() ?? ""
		if (!connector.includes("edp") && !connector.includes("lvds"))
			displays.push(Number(display_match[1]))
	}
	return ok(displays)
}

type ddc_display = { maximum: number, applied: number | null }

async function read_ddc_brightness(display: number): Promise<Result<{ current: number, maximum: number }>> {
	const result = await run_ddc([
		"getvcp",
		"10",
		"--brief",
		"--display",
		String(display),
	])
	if (!result.ok) return result
	const parsed = parse_ddc_brightness(result.value)
	return parsed ? ok(parsed) : err(new Error(`Invalid DDC brightness for display ${display}: ${result.value}`))
}

const clamp01 = (value: number) =>
	Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const display_write_debounce_ms = 10
const external_refresh_debounce_ms = 60

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
	#external_discovery_idle: Timer | null = null
	#discovery_retry: Timer | null = null
	#retries = 0

	#display_write = debounce(display_write_debounce_ms, () =>
		this.#flush_display_writes(),
	)
	#refresh_external = debounce(external_refresh_debounce_ms, () =>
		this.#refresh_external_displays(),
	)
	#display_write_in_flight = false
	#queued_display_target: number | null = null
	#pending_writes: Array<{ target: number, resolve: (result: Result<"applied" | "superseded">) => void }> = []
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
		if (GLib.find_program_in_path("ddcutil") !== null) {
			this.#external_discovery_idle = idle(() => {
				this.#external_discovery_idle = null
				void this.#refresh_external_displays()
			})
		}
	}

	get initialized() {
		return this.#initialized
	}

	#load_devices() {
		this.#display_device = first_sysfs_device("/sys/class/backlight")
		this.#keyboard_device = first_sysfs_device("/sys/class/leds", (name) => /(?:kbd_backlight|keyboard.*backlight)/i.test(name))
		this.#update_display_available()
	}

	async #load_initial_values() {
		const [keyboard, display] = await Promise.all([
			attempt_async(() => this.#load_keyboard_value()),
			attempt_async(() => this.#load_display_value()),
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

	async #load_keyboard_value() {
		if (!this.#keyboard_device) return
		const base = `/sys/class/leds/${this.#keyboard_device}`
		const [max, current] = await Promise.all([
			readFileAsync(`${base}/max_brightness`).then(Number),
			readFileAsync(`${base}/brightness`).then(Number),
		])
		if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(current))
			throw new Error(`Invalid keyboard brightness from ${base}`)
		this.#keyboard_max = max
		this.#keyboard_value = clamp01(current / max)
	}

	async #load_display_value() {
		if (!this.#display_device) return
		const base = `/sys/class/backlight/${this.#display_device}`
		const [max, current] = await Promise.all([
			readFileAsync(`${base}/max_brightness`).then(Number),
			readFileAsync(`${base}/brightness`).then(Number),
		])
		if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(current))
			throw new Error(`Invalid display brightness from ${base}`)
		this.#display_max = max
		this.#display_value = clamp01(current / this.#display_max)
		this.#internal_applied = Math.round(this.#display_value * 100)
	}

	#watch_devices() {
		if (this.#display_device) {
			const display_path = `/sys/class/backlight/${this.#display_device}/brightness`

			const monitored = attempt(() => monitorFile(display_path, (path) => {
				void readFileAsync(path)
					.then((raw) => {
						const next = clamp01(Number(raw) / this.#display_max)
						this.#internal_applied = Math.round(next * 100)
						if (this.#queued_display_target !== null || this.#display_write_in_flight || next === this.#display_value) return
						this.#display_value = next
						this.notify("display")
					})
					.catch((error) => console.error("brightness.monitor: Failed to read display brightness", error))
			}))
			if (log_error(monitored, "brightness.monitor: Failed to watch display"))
				this.#device_monitors.push(monitored.value)
		}

		if (this.#keyboard_device) {
			const keyboard_path = `/sys/class/leds/${this.#keyboard_device}/brightness`

			const monitored = attempt(() => monitorFile(keyboard_path, (path) => {
				void readFileAsync(path)
					.then((raw) => this.#set_keyboard_from_raw(Number(raw)))
					.catch((error) => console.error("brightness.monitor: Failed to read keyboard brightness", error))
			}))
			if (log_error(monitored, "brightness.monitor: Failed to watch keyboard"))
				this.#device_monitors.push(monitored.value)
		}
	}

	#set_keyboard_from_raw(raw: number) {
		if (!Number.isFinite(raw)) return

		const next = this.#keyboard_max ? clamp01(raw / this.#keyboard_max) : 0
		if (next === this.#keyboard_value) return

		this.#keyboard_value = next
		this.notify("kbd")
	}

	#watch_hotplug() {
		if (GLib.find_program_in_path("ddcutil") === null) return
		const result = attempt(() => {
			this.#hyprland_signal_ids.push(hyprland.connect("monitor-added", () => this.#refresh_external.call()))
			this.#hyprland_signal_ids.push(hyprland.connect("monitor-removed", () => this.#refresh_external.call()))
		})
		log_error(
			result,
			"brightness.watchHotplug: Failed to watch display hotplug",
		)
	}

	#update_display_available() {
		const next =
			this.#display_device.length > 0 || this.#external_displays.size > 0

		if (next === this.#display_available) return

		this.#display_available = next
		this.notify("display-available")
	}

	async #refresh_external_displays() {
		if (GLib.find_program_in_path("ddcutil") === null || this.#finished) return
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

	async #discover_external_displays() {
		if (this.#display_write_in_flight) {
			this.#refresh_after_write = true
			return
		}
		const revision = ++this.#discovery_revision
		const discovered = await discover_ddc_displays()
		if (this.#finished || this.#discovery_requested || revision !== this.#discovery_revision) return
		if (!log_error(discovered, "brightness.ddc.detect: Failed to detect external displays")) {
			this.#retry_discovery()
			return
		}
		const next = new Map<number, ddc_display>()
		let first_value: number | null = null
		let read_failed = false
		for (const display of new Set(discovered.value)) {
			const read = await read_ddc_brightness(display)
			if (this.#finished || this.#discovery_requested || revision !== this.#discovery_revision) return
			if (!log_error(read, `brightness.ddc.read: Failed to read display ${display}`)) {
				read_failed = true
				const previous = this.#external_displays.get(display)
				if (previous) next.set(display, previous)
				continue
			}
			const value = brightness_target(read.value.current / read.value.maximum)
			next.set(display, { maximum: read.value.maximum, applied: value })
			first_value ??= read.value.current / read.value.maximum
		}
		if (this.#discovery_requested) return
		if (this.#display_write_in_flight) {
			this.#refresh_after_write = true
			return
		}
		if (read_failed) this.#retry_discovery()
		else {
			this.#retries = 0
			this.#discovery_retry?.cancel()
			this.#discovery_retry = null
		}
		const previously_available = this.#display_available
		this.#external_displays = next
		if (next.size > 0) this.#initialized = true
		this.#update_display_available()
		if (!this.#display_device && first_value !== null && !previously_available && this.#queued_display_target === null && !this.#display_write_in_flight) {
			const normalized = clamp01(first_value)
			if (normalized !== this.#display_value) {
				this.#display_value = normalized
				this.notify("display")
			}
		}
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
			const result = await this.#apply_display_brightness(target)
			for (const pending of this.#pending_writes) {
				if (pending.target === target)
					pending.resolve(result.ok ? ok("applied") : result)
			}
			this.#pending_writes = this.#pending_writes.filter((pending) => pending.target !== target)
		} finally {
			this.#display_write_in_flight = false
			if (this.#refresh_after_write && !this.#finished) {
				this.#refresh_after_write = false
				this.#refresh_external.call()
			}

			if (!this.#finished && this.#queued_display_target !== null) {
				void this.#flush_display_writes()
			}
		}
	}

	async #apply_display_brightness(target: number): Promise<Result<void>> {
		const failures: unknown[] = []
		const controlled = Boolean(this.#display_device) || this.#external_displays.size > 0
		if (this.#display_device && this.#internal_applied !== target) {
			const result = await attempt_async(async () =>
				execAsync(["brightnessctl", "-d", this.#display_device, "set", `${target}%`, "-q"]),
			)
			log_error(
				result,
				"brightness.write: Failed to set internal display brightness",
			)
			if (result.ok) this.#internal_applied = target
			else failures.push(result.err)
		}
		for (const [display, state] of this.#external_displays) {
			if (state.applied === target) continue
			const result = await run_ddc([
				"setvcp", "10", String(brightness_target(target / 100, state.maximum)),
				"--display", String(display), "--noverify",
			])
			log_error(result, `brightness.ddc.write: Failed to set display ${display} to ${target}%`)
			if (result.ok) state.applied = target
			else failures.push(result.err)
		}
		if (this.#queued_display_target === null &&
			(this.#display_device && this.#internal_applied !== target ||
			[...this.#external_displays.values()].some((display) => display.applied !== target))) {
			const actual = this.#display_device ? this.#internal_applied : this.#external_displays.values().next().value?.applied
			if (actual != null) {
				this.#display_value = actual / 100
				this.notify("display")
			}
		}
		if (!controlled) return err(new Error("No brightness devices are available"))
		return failures.length > 0
			? err(new Error(`Brightness ${target}% failed on ${failures.length} device(s)`, { cause: failures }))
			: ok(undefined)
	}

	@getter(Number)
	get kbd() {
		return this.#keyboard_value
	}

	@getter(Number)
	get display() {
		return this.#display_value
	}

	set_display(percent: number): Promise<Result<"applied" | "superseded">> {
		if (!this.#display_available || !this.#initialized)
			return Promise.resolve(err(new Error("No initialized brightness device is available")))

		const value = clamp01(percent)
		const target = brightness_target(value)

		for (const pending of this.#pending_writes) pending.resolve(ok("superseded"))
		this.#pending_writes = []
		const result = new Promise<Result<"applied" | "superseded">>((resolve) => {
			this.#pending_writes.push({ target, resolve })
		})
		this.#queued_display_target = target
		this.#display_write.call()

		if (value !== this.#display_value) {
			this.#display_value = value
			this.notify("display")
		}
		return result
	}

	@getter(Boolean)
	get displayAvailable() {
		return this.#display_available
	}

	vfunc_finalize() {
		this.#finished = true
		for (const pending of this.#pending_writes) pending.resolve(err(new Error("Brightness service stopped")))
		this.#pending_writes = []
		this.#discovery_revision++
		this.#external_discovery_idle?.cancel()
		this.#discovery_retry?.cancel()
		this.#external_discovery_idle = null
		this.#display_write.cancel()
		this.#refresh_external.cancel()

		for (const id of this.#hyprland_signal_ids) {
			hyprland.disconnect(id)
		}
		this.#hyprland_signal_ids = []
		for (const monitor of this.#device_monitors) monitor.cancel()
		this.#device_monitors = []

		super.vfunc_finalize()
	}
}

export const brightness = new Brightness()
