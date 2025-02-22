import { monitorFile, readFileAsync, exec, execAsync, GObject, register, property } from "astal"
import { bash } from "../lib/utils"

const get = (args: string) => Number(exec(`brightnessctl ${args}`))
const display = await bash`ls -w1 /sys/class/backlight | head -1`
const kbd = await bash`ls -w1 /sys/class/leds | head -1`

@register({ GTypeName: "Brightness" })
export default class Brightness extends GObject.Object {
	static instance: Brightness
	static get_default() {
		if (!this.instance)
			this.instance = new Brightness()

		return this.instance
	}

	#kbdMax = get(`--device ${kbd} max`)
	#kbd = get(`--device ${kbd} get`)
	#displayMax = get("max")
	#display = get("get") / (get("max") || 1)
	#displayAvailable = display.length != 0

	@property(Number)
	get kbd() { return this.#kbd }
	set kbd(value) {
		if (value < 0 || value > this.#kbdMax)
			return

		execAsync(`brightnessctl -d ${kbd} s ${value} -q`).then(() => {
			this.#kbd = value
		})
	}

	@property(String)
	get kbdIcon() {
		if (this.#kbd == 0) {
			return "keyboard-brightness-off-symbolic";
		} else if (this.#kbd == 0.5) {
			return "keyboard-brightness-medium-symbolic";
		} else {
			return "keyboard-brightness-high-symbolic";
		}
	}

	@property(Number)
	get display() { return this.#display }
	set display(percent) {
		if (percent < 0)
			percent = 0

		if (percent > 1)
			percent = 1

		execAsync(`brightnessctl set ${Math.floor(percent * 100)}% -q`).then(() => {
			this.#display = percent
		})
	}

	@property(Boolean)
	get displayAvailable() { return this.#displayAvailable }


	@property(String)
	get displayIcon() {
		if (this.#display < 0.4) {
			return "display-brightness-low-symbolic";
		} else if (this.#display < 0.8) {
			return "display-brightness-medium-symbolic";
		} else {
			return "display-brightness-high-symbolic";
		}
	}

	constructor() {
		super()

		const displayPath = `/sys/class/backlight/${display}/brightness`
		const kbdPath = `/sys/class/leds/${kbd}/brightness`

		monitorFile(displayPath, async f => {
			const v = await readFileAsync(f)
			this.#display = Number(v) / this.#displayMax
			this.notify("display")
		})

		monitorFile(kbdPath, async f => {
			const v = await readFileAsync(f)
			this.#kbd = Number(v) / this.#kbdMax
			this.notify("kbd")
		})
	}
}
