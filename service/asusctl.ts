import GObject, { getter, register, setter } from "ags/gobject"
import { sh, bashSync } from "$lib/utils"
import { hypr } from "$lib/services"
import options from "options"

export namespace Asusctl {
	export type Profile = "Performance" | "Balanced" | "Quiet"
	export type Mode = "Hybrid" | "Integrated"
}

@register()
export default class Asusctl extends GObject.Object {
	declare static $gtype: GObject.GType<Asusctl>
	static instance: Asusctl
	static get_default() {
		return this.instance ??= new Asusctl()
	}

	#profile: Asusctl.Profile = "Balanced"
	#mode: Asusctl.Mode = "Hybrid"
	#available: boolean = false

	constructor() {
		super()
		try {
			const hasAsusctl = bashSync`which asusctl`.trim() !== ""
			const asusdRunning = hasAsusctl && bashSync`pgrep -x asusd`.trim() !== ""
			this.#available = asusdRunning
		} catch {
			this.#available = false
		}

		if (this.#available) {
			this.init().catch(() => {
				this.#available = false
			})
		}
	}

	@getter(Array)
	get profiles(): Asusctl.Profile[] {
		return ["Performance", "Balanced", "Quiet"]
	}

	@getter(String)
	get profile(): string {
		return this.#profile
	}

	@setter(String)
	set profile(p: Asusctl.Profile) {
		if (!this.#available) return
		this.setProfile(p)
	}

	@getter(String)
	get mode(): string {
		return this.#mode
	}

	@getter(Boolean)
	get available(): boolean {
		return this.#available
	}

	readonly setProfile = async (p: Asusctl.Profile) => {
		if (!this.#available) return
		try {
			await sh(`asusctl profile -P ${p}`)
			this.#profile = p
			this.notify("profile")
			this.updMonitorCfg()
		} catch {
			this.#available = false
		}
	}

	readonly nextProfile = async () => {
		if (!this.#available) return
		try {
			await sh("asusctl profile -n")
			const output = await sh("asusctl profile -p")
			const match = output.match(/Active profile is (\w+)/)
			this.#profile = match?.[1] as Asusctl.Profile
			this.notify("profile")
			this.updMonitorCfg()
		} catch {
			this.#available = false
		}
	}

	readonly nextMode = async () => {
		if (!this.#available) return
		try {
			const newMode = this.#mode === "Hybrid" ? "Integrated" : "Hybrid"
			await sh(`supergfxctl -m ${newMode}`)
			const modeOut = await sh("supergfxctl -g")
			this.#mode = modeOut as Asusctl.Mode
			this.notify("mode")
		} catch {
			this.#available = false
		}
	}

	readonly updMonitorCfg = async () => {
		if (!this.#available) return
		try {
			const resolution = options.asus.resolution.peek()
			const cmd = this.#profile === "Quiet"
				? `keyword monitor eDP-1,${resolution}@${options.asus.bat_hz.peek()},0x0,1`
				: `keyword monitor eDP-1,${resolution}@${options.asus.ac_hz.peek()},0x0,1`
			hypr.message_async(cmd, null)
		} catch { }
	}

	readonly init = async () => {
		try {
			const p = await sh("asusctl profile -p")
			const match = p.match(/Active profile is (\w+)/)
			this.#profile = match?.[1] as Asusctl.Profile
			this.notify("profile")

			const mode = await sh("supergfxctl -g")
			this.#mode = mode as Asusctl.Mode
			this.notify("mode")

			this.updMonitorCfg()

			options.asus.resolution.subscribe(() => this.updMonitorCfg())
			options.asus.ac_hz.subscribe(() => this.updMonitorCfg())
			options.asus.bat_hz.subscribe(() => this.updMonitorCfg())
		} catch {
			this.#available = false
			throw new Error("Asusctl initialization failed")
		}
	}
}
