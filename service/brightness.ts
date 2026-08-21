// Reads and changes screen and keyboard brightness and watches for connected displays.

import GObject, { getter, register, setter } from "ags/gobject"
import { monitorFile, readFileAsync } from "ags/file"
import { execAsync } from "ags/process"
import { idle, Timer } from "ags/time"

import Gio from "gi://Gio"

import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/time"
import { hyprland } from "$service/astal"

function firstSysfsDevice(directory: string): string {
	const result = attempt(() => {
		const enumerator = Gio.File.new_for_path(directory).enumerate_children(
			"standard::name",
			Gio.FileQueryInfoFlags.NONE,
			null,
		)
		const names: string[] = []
		let info: Gio.FileInfo | null
		while ((info = enumerator.next_file(null)) !== null)
			names.push(info.get_name())
		enumerator.close(null)
		return names.sort()[0] ?? ""
	})
	return result.ok ? result.value : ""
}

async function discoverDdcDisplays(): Promise<number[]> {
	const result = await attemptAsync(async () => execAsync(["ddcutil", "detect"]))
	if (!result.ok) {
		console.error("brightness.ddc.detect: Failed to detect external displays", result.err)
		return []
	}

	const displays: number[] = []
	for (const block of result.value.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)) {
		const displayMatch = block.match(/^Display\s+(\d+)/m)
		if (!displayMatch) continue

		const connector = block.match(/DRM connector:\s+([^\n]+)/i)?.[1]?.toLowerCase() ?? ""
		if (!connector.includes("edp") && !connector.includes("lvds"))
			displays.push(Number(displayMatch[1]))
	}
	return displays
}

async function readDdcBrightness(display: number): Promise<number | null> {
	const result = await attemptAsync(async () => execAsync([
		"ddcutil", "getvcp", "10", "--brief", "--display", String(display),
	]))
	if (!result.ok) {
		console.error(`brightness.ddc.read: Failed to read display ${display}`, result.err)
		return null
	}

	const match = result.value.match(/current value =\s*(\d+)/i) || result.value.match(/\b10\s+(\d+)\s+\d+\b/)
	if (!match) return null

	const value = Number(match[1])
	return Number.isFinite(value) ? value : null
}

async function setDdcBrightness(displays: readonly number[], target: number): Promise<boolean> {
	let writeSucceeded = false
	for (const display of displays) {
		const result = await attemptAsync(async () => execAsync([
			"ddcutil", "setvcp", "10", String(target), "--display", String(display), "--noverify",
		]))
		if (!result.ok)
			console.error(`brightness.ddc.write: Failed to set display ${display} to ${target}%`, result.err)
		writeSucceeded = writeSucceeded || result.ok
	}
	return writeSucceeded
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const DISPLAY_WRITE_DEBOUNCE_MS = 10
const EXTERNAL_REFRESH_DEBOUNCE_MS = 60

@register()
class Brightness extends GObject.Object {
	declare static $gtype: GObject.GType<Brightness>
	static instance: Brightness

	static get_default() {
		return this.instance ??= new Brightness()
	}

	#displayDevice = ""
	#keyboardDevice = ""

	#displayMax = 1
	#displayValue = 0
	#displayAvailable = false
	#externalDisplays: number[] = []

	#keyboardMax = 0
	#keyboardValue = 0

	#hyprlandSignalIds: number[] = []
	#deviceMonitors: Gio.FileMonitor[] = []
	#externalDiscoveryIdle: Timer | null = null

	#displayWrite = debounce(DISPLAY_WRITE_DEBOUNCE_MS, () => this.#flushDisplayWrites())
	#refreshExternal = debounce(EXTERNAL_REFRESH_DEBOUNCE_MS, () => this.#refreshExternalDisplays())
	#displayWriteInFlight = false
	#queuedDisplayTarget: number | null = null
	#lastAppliedDisplayTarget: number | null = null
	#initialized = false

	constructor() {
		super()
		void this.#init()
	}

	async #init() {
		const result = await attemptAsync(async () => {
			this.#loadDevices()
			await this.#loadInitialValues()
			this.#notifyDisplay()
			this.#notifyKeyboard()
			this.#watchDevices()
			this.#watchHotplug()
		})
		if (!result.ok)
			console.error("brightness.init: Failed to initialize brightness service", result.err)
		if (this.#displayDevice)
			this.#initialized = true
		this.#externalDiscoveryIdle = idle(() => {
			this.#externalDiscoveryIdle = null
			void this.#refreshExternalDisplays().finally(() => {
				this.#initialized = true
			})
		})
	}

	#notifyDisplay() {
		this.notify("display")
	}

	#notifyKeyboard() {
		this.notify("kbd")
	}

	get initialized() {
		return this.#initialized
	}

	#loadDevices() {
		this.#displayDevice = firstSysfsDevice("/sys/class/backlight")
		this.#keyboardDevice = firstSysfsDevice("/sys/class/leds")
		this.#updateDisplayAvailable()
	}

	async #loadInitialValues() {
		const [keyboard, display] = await Promise.all([
			attemptAsync(() => this.#loadKeyboardValue()),
			attemptAsync(() => this.#loadDisplayValue()),
		])
		if (!keyboard.ok)
			console.error("brightness.init: Failed to read keyboard brightness", keyboard.err)
		if (!display.ok)
			console.error("brightness.init: Failed to read display brightness", display.err)
	}

	async #loadKeyboardValue() {
		if (!this.#keyboardDevice) return
		const base = `/sys/class/leds/${this.#keyboardDevice}`
		const [max, current] = await Promise.all([
			readFileAsync(`${base}/max_brightness`).then(Number),
			readFileAsync(`${base}/brightness`).then(Number),
		])
		this.#keyboardMax = Number.isFinite(max) && max > 0 ? max : 0
		this.#keyboardValue = this.#keyboardMax > 0 ? clamp01(current / this.#keyboardMax) : 0
	}

	async #loadDisplayValue() {
		if (!this.#displayDevice) return
		const base = `/sys/class/backlight/${this.#displayDevice}`
		const [max, current] = await Promise.all([
			readFileAsync(`${base}/max_brightness`).then(Number),
			readFileAsync(`${base}/brightness`).then(Number),
		])
		this.#displayMax = Number.isFinite(max) && max > 0 ? max : 1
		this.#displayValue = clamp01(current / this.#displayMax)
		this.#lastAppliedDisplayTarget = Math.round(this.#displayValue * 100)
	}

	#watchDevices() {
		if (this.#displayDevice) {
			const displayPath = `/sys/class/backlight/${this.#displayDevice}/brightness`

			this.#deviceMonitors.push(monitorFile(displayPath, path => {
				void readFileAsync(path).then(raw => {
					const next = clamp01(Number(raw) / this.#displayMax)
					if (next === this.#displayValue) return
					this.#displayValue = next
					this.#lastAppliedDisplayTarget = Math.round(next * 100)
					this.#notifyDisplay()
				}).catch(error => console.error("brightness.monitor: Failed to read display brightness", error))
			}))
		}

		if (this.#keyboardDevice) {
			const keyboardPath = `/sys/class/leds/${this.#keyboardDevice}/brightness`

			this.#deviceMonitors.push(monitorFile(keyboardPath, path => {
				void readFileAsync(path)
					.then(raw => this.#setKeyboardFromRaw(Number(raw)))
					.catch(error => console.error("brightness.monitor: Failed to read keyboard brightness", error))
			}))
		}
	}

	#setKeyboardFromRaw(raw: number) {
		if (!Number.isFinite(raw))
			return

		const next = this.#keyboardMax ? clamp01(raw / this.#keyboardMax) : 0
		if (next === this.#keyboardValue)
			return

		this.#keyboardValue = next
		this.#notifyKeyboard()
	}

	#watchHotplug() {
		const result = attempt(() => {
			this.#hyprlandSignalIds.push(
				hyprland.connect("monitor-added", () => this.#refreshExternal.call()),
				hyprland.connect("monitor-removed", () => this.#refreshExternal.call()),
			)
		})
		if (!result.ok)
			console.error("brightness.watchHotplug: Failed to watch display hotplug", result.err)
	}

	#updateDisplayAvailable() {
		const next =
			this.#displayDevice.length > 0 ||
			this.#externalDisplays.length > 0

		if (next === this.#displayAvailable)
			return

		this.#displayAvailable = next
		this.notify("display-available")
	}

	async #refreshExternalDisplays() {
		const displays = await discoverDdcDisplays()
		const next = Array.from(new Set(displays)).sort((a, b) => a - b)

		const changed =
			next.length !== this.#externalDisplays.length ||
			next.some((display, index) => display !== this.#externalDisplays[index])

		this.#externalDisplays = next
		if (next.length > 0)
			this.#initialized = true
		this.#updateDisplayAvailable()

		if (!changed)
			return

		if (!this.#displayDevice && next.length > 0) {
			const value = await readDdcBrightness(next[0])
			if (value !== null) {
				const normalized = clamp01(value / 100)

				if (normalized !== this.#displayValue) {
					this.#displayValue = normalized
					this.#lastAppliedDisplayTarget = Math.round(normalized * 100)
					this.#notifyDisplay()
				}
			}
		}
	}

	#queueDisplayWrite(target: number) {
		this.#queuedDisplayTarget = target
		this.#displayWrite.call()
	}

	async #flushDisplayWrites() {
		if (this.#displayWriteInFlight)
			return

		const target = this.#queuedDisplayTarget
		if (target === null)
			return

		this.#queuedDisplayTarget = null

		if (target === this.#lastAppliedDisplayTarget)
			return

		this.#displayWriteInFlight = true

		try {
			const writeSucceeded = await this.#applyDisplayBrightness(target)

			if (writeSucceeded) {
				this.#lastAppliedDisplayTarget = target
			} else {
				console.error(`brightness.write: No display accepted brightness ${target}%`)
				if (this.#queuedDisplayTarget === null && this.#lastAppliedDisplayTarget !== null) {
					this.#displayValue = this.#lastAppliedDisplayTarget / 100
					this.#notifyDisplay()
				}
			}
		} finally {
			this.#displayWriteInFlight = false

			if (this.#queuedDisplayTarget !== null) {
				void this.#flushDisplayWrites()
			}
		}
	}

	async #applyDisplayBrightness(target: number): Promise<boolean> {
		let writeSucceeded = false

		if (this.#displayDevice) {
			const result = await attemptAsync(async () => execAsync(["brightnessctl", "set", `${target}%`, "-q"]))
			if (!result.ok)
				console.error("brightness.write: Failed to set internal display brightness", result.err)
			writeSucceeded = result.ok
		}

		const externalWriteSucceeded = await setDdcBrightness(this.#externalDisplays, target)
		return writeSucceeded || externalWriteSucceeded
	}

	@getter(Number)
	get kbd() {
		return this.#keyboardValue
	}

	@setter(Number)
	set kbd(percent) {
		const value = clamp01(percent)

		if (!this.#keyboardDevice || !this.#keyboardMax)
			return

		const target = Math.round(value * this.#keyboardMax)

		execAsync(["brightnessctl", "-d", this.#keyboardDevice, "s", String(target), "-q"]).then(() => {
			this.#keyboardValue = value
			this.#notifyKeyboard()
		}).catch(error => console.error("brightness.kbd: Failed to set keyboard brightness", error))
	}

	@getter(Number)
	get display() {
		return this.#displayValue
	}

	@setter(Number)
	set display(percent) {
		if (!this.#initialized && !this.#displayDevice)
			return

		const value = clamp01(percent)
		const target = Math.round(value * 100)

		if (target !== this.#lastAppliedDisplayTarget) {
			this.#queueDisplayWrite(target)
		}

		if (value === this.#displayValue)
			return

		this.#displayValue = value
		this.#notifyDisplay()
	}

	@getter(Boolean)
	get displayAvailable() {
		return this.#displayAvailable
	}

	vfunc_finalize() {
		this.#externalDiscoveryIdle?.cancel()
		this.#externalDiscoveryIdle = null
		this.#displayWrite.cancel()
		this.#refreshExternal.cancel()

		for (const id of this.#hyprlandSignalIds) {
			hyprland.disconnect(id)
		}
		this.#hyprlandSignalIds = []
		for (const monitor of this.#deviceMonitors)
			monitor.cancel()
		this.#deviceMonitors = []

		super.vfunc_finalize()
	}
}

export const brightness = Brightness.get_default()
