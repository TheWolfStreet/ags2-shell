import GObject, { getter, register, setter } from "ags/gobject"
import { monitorFile, readFileAsync } from "ags/file"
import { exec, execAsync } from "ags/process"

import GLib from "gi://GLib"

import { bashSync } from "../lib/utils"
import { getBrightnessIcon } from "../lib/icons"

const get = (args: string) => Number(exec(`brightnessctl ${args}`))

@register()
export default class Brightness extends GObject.Object {
	declare static $gtype: GObject.GType<Brightness>
	static instance: Brightness

	static get_default() {
		return this.instance ??= new Brightness()
	}

	#display: string
	#kbd: string
	#kbdMax: number
	#kbdValue: number
	#displayMax: number
	#displayValue: number
	#displayAvailable: boolean
	#kbdIntervalId: GLib.Source | null = null

	constructor() {
		super()

		this.#display = ""
		this.#kbd = ""
		this.#kbdMax = 0
		this.#kbdValue = 0
		this.#displayMax = 1
		this.#displayValue = 0
		this.#displayAvailable = false

		try {
			this.#display = bashSync`ls -w1 /sys/class/backlight | head -1`.trim()
			this.#kbd = bashSync`ls -w1 /sys/class/leds | head -1`.trim()

			this.#kbdMax = get(`--device ${this.#kbd} max`)
			this.#kbdValue = get(`--device ${this.#kbd} get`)
			this.#displayMax = get("max")
			this.#displayValue = get("get") / (get("max") || 1)
			this.#displayAvailable = this.#display.length != 0

			const displayPath = `/sys/class/backlight/${this.#display}/brightness`
			const kbdPath = `/sys/class/leds/${this.#kbd}/brightness`

			monitorFile(displayPath, async f => {
				const v = await readFileAsync(f)
				this.#displayValue = Number(v) / this.#displayMax
				this.notify("display")
			})

			this.#monitorKbd(kbdPath, (v) => {
				this.#kbdValue = v / this.#kbdMax
				this.notify("kbd")
			})
		} catch (e) {
			console.error("Failed to initialize brightness service:", e)
		}
	}

	@getter(Number)
	get kbd() { return this.#kbdValue }

	@setter(Number)
	set kbd(value) {
		if (value < 0 || value > this.#kbdMax)
			return

		execAsync(`brightnessctl -d ${this.#kbd} s ${value} -q`).then(() => {
			this.#kbdValue = value
		})
	}

	@getter(String)
	get kbdIcon(): string {
		return getBrightnessIcon(this.#kbdValue, "keyboard")
	}

	@getter(Number)
	get display() { return this.#displayValue }

	@setter(Number)
	set display(percent) {
		if (percent < 0)
			percent = 0

		if (percent > 1)
			percent = 1

		execAsync(`brightnessctl set ${Math.floor(percent * 100)}% -q`).then(() => {
			this.#displayValue = percent
		})
	}

	@getter(Boolean)
	get displayAvailable() { return this.#displayAvailable }


	@getter(String)
	get iconName(): string {
		return getBrightnessIcon(this.#displayValue, "screen")
	}


	readonly #monitorKbd = async (path: string, callback: (v: number) => void, interval = 100) => {
		let last = await readFileAsync(path)
		this.#kbdIntervalId = setInterval(async () => {
			const curr = await readFileAsync(path)
			if (curr !== last) {
				last = curr
				callback(Number(curr))
			}
		}, interval)
	}

	vfunc_finalize() {
		if (this.#kbdIntervalId) {
			clearInterval(this.#kbdIntervalId)
			this.#kbdIntervalId = null
		}
		super.vfunc_finalize()
	}
}
