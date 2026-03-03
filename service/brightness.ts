import GObject, { getter, register, setter } from "ags/gobject"
import { monitorFile, readFileAsync } from "ags/file"
import { execAsync } from "ags/process"

import Hyprland from "gi://AstalHyprland"

import { getBrightnessIcon } from "$lib/icons"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/timing"

const readBrightness = async (args: string): Promise<number> => {
	const result = await attemptAsync(async () => Number(await execAsync(`brightnessctl ${args}`)))
	return result.ok ? result.value : Number.NaN
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const DISPLAY_WRITE_DEBOUNCE_MS = 10
const EXTERNAL_REFRESH_DEBOUNCE_MS = 60

@register()
export default class Brightness extends GObject.Object {
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

	#hyprland = Hyprland.get_default()
	#hyprlandSignalIds: number[] = []

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
		this.#displayDevice = (await execAsync(["bash", "-c", "ls -w1 /sys/class/backlight 2>/dev/null | head -1"]).catch(() => "")).trim()
		this.#keyboardDevice = (await execAsync(["bash", "-c", "ls -w1 /sys/class/leds 2>/dev/null | head -1"]).catch(() => "")).trim()

		await this.#refreshExternalDisplays()
	}

	async #loadInitialValues() {
		if (this.#keyboardDevice) {
			const max = await readBrightness(`--device ${this.#keyboardDevice} max`)
			this.#keyboardMax = Number.isFinite(max) && max > 0 ? max : 0

			if (this.#keyboardMax > 0) {
				const current = await readBrightness(`--device ${this.#keyboardDevice} get`)
				this.#keyboardValue = clamp01(current / this.#keyboardMax)
			} else {
				this.#keyboardValue = 0
			}
		}

		if (this.#displayDevice) {
			const max = await readBrightness("max")
			this.#displayMax = Number.isFinite(max) && max > 0 ? max : 1

			const current = await readBrightness("get")
			this.#displayValue = clamp01(current / this.#displayMax)
			this.#lastAppliedDisplayTarget = Math.round(this.#displayValue * 100)
			return
		}

		if (this.#externalDisplays.length > 0) {
			const value = await this.#getExternalBrightness(this.#externalDisplays[0])
			if (value !== null) {
				this.#displayValue = clamp01(value / 100)
				this.#lastAppliedDisplayTarget = Math.round(this.#displayValue * 100)
			}
		}
	}

	#watchDevices() {
		if (this.#displayDevice) {
			const displayPath = `/sys/class/backlight/${this.#displayDevice}/brightness`

			monitorFile(displayPath, async path => {
				const value = Number(await readFileAsync(path))
				const next = clamp01(value / this.#displayMax)

				if (next === this.#displayValue)
					return

				this.#displayValue = next
				this.#lastAppliedDisplayTarget = Math.round(next * 100)
				this.notify("display")
			})
		}

		if (this.#keyboardDevice) {
			const keyboardPath = `/sys/class/leds/${this.#keyboardDevice}/brightness`

			monitorFile(keyboardPath, async path => {
				const value = Number(await readFileAsync(path))
				this.#setKeyboardFromRaw(value)
			})
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
				this.#hyprland.connect("monitor-added", () => this.#refreshExternal.call()),
				this.#hyprland.connect("monitor-removed", () => this.#refreshExternal.call()),
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
		const displays = await this.#getExternalDdcDisplays()
		const next = Array.from(new Set(displays)).sort((a, b) => a - b)

		const changed =
			next.length !== this.#externalDisplays.length ||
			next.some((display, index) => display !== this.#externalDisplays[index])

		this.#externalDisplays = next
		this.#updateDisplayAvailable()

		if (!changed)
			return

		if (!this.#displayDevice && next.length > 0) {
			const value = await this.#getExternalBrightness(next[0])
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

	async #getExternalDdcDisplays(): Promise<number[]> {
		const out = await execAsync("ddcutil detect").catch(() => "")

		const blocks = out
			.split(/\n\s*\n/)
			.map(block => block.trim())
			.filter(Boolean)

		const displays: number[] = []

		for (const block of blocks) {
			const displayMatch = block.match(/^Display\s+(\d+)/m)
			if (!displayMatch)
				continue

			const connectorMatch = block.match(/DRM connector:\s+([^\n]+)/i)
			const connector = connectorMatch?.[1]?.toLowerCase() ?? ""

			if (connector.includes("edp") || connector.includes("lvds"))
				continue

			displays.push(Number(displayMatch[1]))
		}

		return displays
	}

	async #getExternalBrightness(display: number): Promise<number | null> {
		const out = await execAsync(`ddcutil getvcp 10 --brief --display ${display}`).catch(() => "")

		const match =
			out.match(/current value =\s*(\d+)/i) ||
			out.match(/\b10\s+(\d+)\s+\d+\b/)

		if (!match)
			return null

		const value = Number(match[1])
		return Number.isFinite(value) ? value : null
	}

	async #setExternalBrightness(target: number): Promise<boolean> {
		if (this.#externalDisplays.length === 0)
			return false

		let changed = false

		for (const display of this.#externalDisplays) {
			const ok = await execAsync([
				"ddcutil",
				"setvcp",
				"10",
				String(target),
				"--display",
				String(display),
				"--noverify",
			]).then(() => true).catch(() => false)

			changed = changed || ok
		}

		return changed
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
			const changed = await this.#applyDisplayBrightness(target)

			if (changed) {
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
		let changed = false

		if (this.#displayDevice) {
			const ok = await execAsync(["brightnessctl", "set", `${target}%`, "-q"])
				.then(() => true)
				.catch(() => false)

			changed = changed || ok
		}

		const externalChanged = await this.#setExternalBrightness(target)
		return changed || externalChanged
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
			this.#hyprland.disconnect(id)
		}
		this.#hyprlandSignalIds = []

		super.vfunc_finalize()
	}
}
