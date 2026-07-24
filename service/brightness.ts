// Reads and changes screen and keyboard brightness and watches for connected displays.

import GObject, { getter, register, setter } from "ags/gobject"
import { monitorFile, readFileAsync } from "ags/file"
import { execAsync } from "ags/process"

import Gio from "gi://Gio"

import { getBrightnessIcon } from "$lib/icons"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/timing"
import { hyprland } from "$service/system"
import { discoverExternalDisplays, readExternalBrightness, writeExternalBrightness } from "$service/brightness/ddc"
import { firstDevice } from "$service/brightness/sysfs"

const readBrightness = async (args: string[]): Promise<number> => {
	const result = await attemptAsync(async () => Number(await execAsync(["brightnessctl", ...args])))
	return result.ok ? result.value : Number.NaN
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
			await this.#loadDevices()
			await this.#loadInitialValues()
			this.#watchDevices()
			this.#watchHotplug()
		})
		if (!result.ok)
			console.error("brightness.init: Failed to initialize brightness service", result.err)
		this.#initialized = true
	}

	async #loadDevices() {
		this.#displayDevice = firstDevice("/sys/class/backlight")
		this.#keyboardDevice = firstDevice("/sys/class/leds")

		await this.#refreshExternalDisplays()
	}

	async #loadInitialValues() {
		if (this.#keyboardDevice) {
			const max = await readBrightness(["--device", this.#keyboardDevice, "max"])
			this.#keyboardMax = Number.isFinite(max) && max > 0 ? max : 0

			if (this.#keyboardMax > 0) {
				const current = await readBrightness(["--device", this.#keyboardDevice, "get"])
				this.#keyboardValue = clamp01(current / this.#keyboardMax)
			} else {
				this.#keyboardValue = 0
			}
		}

		if (this.#displayDevice) {
			const max = await readBrightness(["max"])
			this.#displayMax = Number.isFinite(max) && max > 0 ? max : 1

			const current = await readBrightness(["get"])
			this.#displayValue = clamp01(current / this.#displayMax)
			this.#lastAppliedDisplayTarget = Math.round(this.#displayValue * 100)
			return
		}

		if (this.#externalDisplays.length > 0) {
			const value = await readExternalBrightness(this.#externalDisplays[0])
			if (value !== null) {
				this.#displayValue = clamp01(value / 100)
				this.#lastAppliedDisplayTarget = Math.round(this.#displayValue * 100)
			}
		}
	}

	#watchDevices() {
		if (this.#displayDevice) {
			const displayPath = `/sys/class/backlight/${this.#displayDevice}/brightness`

			this.#deviceMonitors.push(monitorFile(displayPath, async path => {
				const value = Number(await readFileAsync(path))
				const next = clamp01(value / this.#displayMax)

				if (next === this.#displayValue)
					return

				this.#displayValue = next
				this.#lastAppliedDisplayTarget = Math.round(next * 100)
				this.notify("display")
			}))
		}

		if (this.#keyboardDevice) {
			const keyboardPath = `/sys/class/leds/${this.#keyboardDevice}/brightness`

			this.#deviceMonitors.push(monitorFile(keyboardPath, async path => {
				const value = Number(await readFileAsync(path))
				this.#setKeyboardFromRaw(value)
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
		this.notify("kbd")
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
		const displays = await discoverExternalDisplays()
		const next = Array.from(new Set(displays)).sort((a, b) => a - b)

		const changed =
			next.length !== this.#externalDisplays.length ||
			next.some((display, index) => display !== this.#externalDisplays[index])

		this.#externalDisplays = next
		this.#updateDisplayAvailable()

		if (!changed)
			return

		if (!this.#displayDevice && next.length > 0) {
			const value = await readExternalBrightness(next[0])
			if (value !== null) {
				const normalized = clamp01(value / 100)

				if (normalized !== this.#displayValue) {
					this.#displayValue = normalized
					this.#lastAppliedDisplayTarget = Math.round(normalized * 100)
					this.notify("display")
				}
			}
		}
	}

	// At most one write is in flight; intermediate targets collapse to the newest one.
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
			const succeeded = await execAsync(["brightnessctl", "set", `${target}%`, "-q"])
				.then(() => true)
				.catch(() => false)

			writeSucceeded = writeSucceeded || succeeded
		}

		const externalWriteSucceeded = await writeExternalBrightness(this.#externalDisplays, target)
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
			this.notify("kbd")
		}).catch(() => { })
	}

	@getter(String)
	get kbdIcon(): string {
		return getBrightnessIcon(this.#keyboardValue, "keyboard")
	}

	@getter(Number)
	get display() {
		return this.#displayValue
	}

	@setter(Number)
	set display(percent) {
		if (!this.#initialized)
			return

		const value = clamp01(percent)
		const target = Math.round(value * 100)

		if (target !== this.#lastAppliedDisplayTarget) {
			this.#queueDisplayWrite(target)
		}

		if (value === this.#displayValue)
			return

		this.#displayValue = value
		this.notify("display")
	}

	@getter(Boolean)
	get displayAvailable() {
		return this.#displayAvailable
	}

	@getter(String)
	get iconName(): string {
		return getBrightnessIcon(this.#displayValue, "screen")
	}

	vfunc_finalize() {
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
