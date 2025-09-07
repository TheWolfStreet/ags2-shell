import GObject, { getter, register, setter } from "ags/gobject"

import { sh, bashSync } from "$lib/utils"
import { hypr } from "$lib/services"

import options from "options"

export namespace Asusctl {
	export type Profile = "Performance" | "Balanced" | "Quiet"
	export type Mode = "Hybrid" | "Integrated"
}

@register({ GTypeName: "Asusctl" })
export default class Asusctl extends GObject.Object {
	static instance: Asusctl

	static get_default() {
		return this.instance ??= new Asusctl()
	}

	#profile: Asusctl.Profile = "Balanced"
	#mode: Asusctl.Mode = "Hybrid"
	#available: boolean = bashSync`which asusctl`.trim() !== ""

	constructor() {
		super()
		if (!this.#available) return
		this.init()
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
		await sh(`asusctl profile -P ${p}`)
		this.#profile = p
		this.notify("profile")
		this.updMonitorCfg()
	}

	readonly nextProfile = async () => {
		if (!this.#available) return
		await sh("asusctl profile -n")
		const output = await sh("asusctl profile -p")
		const p = output.split(" ")[5] as Asusctl.Profile
		this.#profile = p
		this.notify("profile")
		this.updMonitorCfg()
	}

	readonly nextMode = async () => {
		if (!this.#available) return
		const newMode = this.#mode === "Hybrid" ? "Integrated" : "Hybrid"
		await sh(`supergfxctl -m ${newMode}`)
		const modeOut = await sh("supergfxctl -g")
		this.#mode = modeOut as Asusctl.Mode
		this.notify("mode")
	}

	readonly updMonitorCfg = async () => {
		const cmd = this.#profile === "Quiet"
			? `keyword monitor eDP-1,1920x1200@${options.asus.bat_hz.get()},0x0,1`
			: `keyword monitor eDP-1,1920x1200@${options.asus.ac_hz.get()},0x0,1`

		hypr.message_async(cmd, null)
	}

	readonly init = async () => {
		const p = await sh("asusctl profile -p")
		this.#profile = p.split(" ")[5] as Asusctl.Profile
		this.notify("profile")

		const mode = await sh("supergfxctl -g")
		this.#mode = mode as Asusctl.Mode
		this.notify("mode")

		this.updMonitorCfg()
	}
}
