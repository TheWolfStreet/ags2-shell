import GObject, { getter, register, setter } from "ags/gobject"
import { monitorFile, readFileAsync } from "ags/file"
import { exec, execAsync } from "ags/process"

import { bash } from "../lib/utils"

const get = (args: string) => Number(exec(`brightnessctl ${args}`))
const display = await bash`ls -w1 /sys/class/backlight | head -1`
const kbd = await bash`ls -w1 /sys/class/leds | head -1`

@register({ GTypeName: "Brightness" })
export default class Brightness extends GObject.Object {
	static instance: Brightness

	static get_default() {
		return this.instance ??= new Brightness()
	}

	#kbdMax = get(`--device ${kbd} max`)
	#kbd = get(`--device ${kbd} get`)
	#displayMax = get("max")
	#display = get("get") / (get("max") || 1)
	#displayAvailable = display.length != 0

	constructor() {
		super()

		const displayPath = `/sys/class/backlight/${display}/brightness`
		const kbdPath = `/sys/class/leds/${kbd}/brightness`

		monitorFile(displayPath, async f => {
			const v = await readFileAsync(f)
			this.#display = Number(v) / this.#displayMax
			this.notify("display")
		})

		this.#monitorKbd(kbdPath, (v) => {
			this.#kbd = v / this.#kbdMax
			this.notify("kbd")
		})
	}

	@getter(Number)
	get kbd() { return this.#kbd }

	@setter(Number)
	set kbd(value) {
		if (value < 0 || value > this.#kbdMax)
			return

		execAsync(`brightnessctl -d ${kbd} s ${value} -q`).then(() => {
			this.#kbd = value
		})
	}

	@getter(String)
	get kbdIcon(): string {
		if (this.#kbd == 0) {
			return "keyboard-brightness-off-symbolic"
		} else if (this.#kbd == 0.5) {
			return "keyboard-brightness-medium-symbolic"
		}
		return "keyboard-brightness-high-symbolic"
	}

	@getter(Number)
	get display() { return this.#display }

	@setter(Number)
	set display(percent) {
		if (percent < 0)
			percent = 0

		if (percent > 1)
			percent = 1

		execAsync(`brightnessctl set ${Math.floor(percent * 100)}% -q`).then(() => {
			this.#display = percent
		})
	}

	@getter(Boolean)
	get displayAvailable() { return this.#displayAvailable }


	@getter(String)
	get iconName(): string {
		if (this.#display < 0.4) {
			return "display-brightness-low-symbolic"
		} else if (this.#display < 0.8) {
			return "display-brightness-medium-symbolic"
		}
		return "display-brightness-high-symbolic"
	}


	readonly #monitorKbd = async (path: string, callback: (v: number) => void, interval = 100) => {
		let last = await readFileAsync(path)
		setInterval(async () => {
			const curr = await readFileAsync(path)
			if (curr !== last) {
				last = curr
				callback(Number(curr))
			}
		}, interval)
	}
}
