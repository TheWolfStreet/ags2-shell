import { GObject, property, register } from "astal"

import { sh, bashSync } from "../lib/utils"
import { hypr } from "../lib/services"

type Profile = "Performance" | "Balanced" | "Quiet"
type Mode = "Hybrid" | "Integrated"

@register({ GTypeName: "Asusctl" })
export default class Asusctl extends GObject.Object {
	static instance: Asusctl

	static get_default() {
		if (!this.instance) {
			this.instance = new Asusctl()
		}
		return this.instance
	}

	#profile: Profile = "Balanced"
	#mode: Mode = "Hybrid"
	#available: boolean = bashSync`which asusctl`.trim() !== ""

	get profiles(): Profile[] {
		return ["Performance", "Balanced", "Quiet"]
	}

	@property(String)
	get profile(): Profile {
		return this.#profile
	}

	set profile(p: Profile) {
		if (!this.#available) return
		sh(`asusctl profile -P ${p}`).then(() => {
			this.#profile = p
			this.notify("profile")
		})
	}

	@property(String)
	get mode(): Mode {
		return this.#mode
	}

	@property(Boolean)
	get available(): boolean {
		return this.#available
	}

	async nextProfile(): Promise<void> {
		if (!this.#available) return
		await sh("asusctl profile -n")
		const p = await sh("asusctl profile -p")
		this.#profile = p.split(" ")[5] as Profile
		this.notify("profile")
	}

	async nextMode(): Promise<void> {
		if (!this.#available) return
		const newMode = this.#mode === "Hybrid" ? "Integrated" : "Hybrid"
		await sh(`supergfxctl -m ${newMode}`)
		this.#mode = (await sh("supergfxctl -g")) as Mode
		this.notify("mode")
	}

	constructor() {
		super()
		this.initializeDefaults()
	}

	private async initializeDefaults() {
		if (!this.#available) return
		const p = await sh("asusctl profile -p")
		this.#profile = p.split(" ")[5] as Profile
		this.notify("profile")

		const mode = await sh("supergfxctl -g")
		this.#mode = mode as Mode
		this.notify("mode")

		this.connect("notify::profile", () => {
			const monitorConfig = this.#profile === "Quiet"
				? "keyword monitor eDP-1,1920x1200@70,0x0,1"
				: "keyword monitor eDP-1,1920x1200@144,0x0,1"

			hypr.message_async(monitorConfig, null)
		})
	}
}
