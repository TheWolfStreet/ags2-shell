// Checks ASUS controls, reads and changes profiles and graphics modes, and applies screen settings.

import GObject, { getter, register, setter } from "ags/gobject"
import { execAsync } from "ags/process"

import { hyprland } from "$service/system"
import { hasProgram } from "$lib/programs"
import { attempt } from "$lib/result"
import options from "options"

const ASUS_HZ_PRESETS = [60, 144, 240]

type MonitorConfiguration = {
	name: string
	disabled: boolean
}

async function runCommand(args: string[]): Promise<string | Error> {
	return execAsync(args).catch(error => new Error(`Command failed: ${args.join(" ")}`, { cause: error }))
}

function parseProfile(raw: string): Asusctl.Profile | Error {
	const value = raw.trim()
	if (value === "Performance" || value === "Balanced" || value === "Quiet")
		return value

	return new Error(`Unexpected profile value: ${value}`)
}

function parseMode(raw: string): Asusctl.Mode | Error {
	const value = raw.trim()
	if (value === "Hybrid" || value === "Integrated")
		return value

	return new Error(`Unexpected mode value: ${value}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function parseModeRefreshRate(mode: string): number | null {
	const match = mode.match(/@\s*([0-9]+(?:\.[0-9]+)?)/)
	if (!match)
		return null

	const hz = Number.parseFloat(match[1])
	return Number.isFinite(hz) && hz > 0 ? hz : null
}

function getPanel() {
	return hyprland.get_monitors().find(monitor => monitor.name === "eDP-1") ?? hyprland.get_monitor(0)
}

function getPanelResolutions(): string[] {
	const resolutions: string[] = []
	for (const mode of getPanel()?.availableModes ?? []) {
		const match = mode.match(/^(\d+)x(\d+)(?:@|$)/)
		if (!match) continue
		const resolution = `${match[1]}x${match[2]}`
		if (!resolutions.includes(resolution)) resolutions.push(resolution)
	}
	return resolutions
}

function normalizeAsusHz(value: number, maxHz: number): number {
	const legalValues = ASUS_HZ_PRESETS.filter(hz => hz <= maxHz)
	const fallback = legalValues[legalValues.length - 1] ?? ASUS_HZ_PRESETS[0]
	if (legalValues.includes(value))
		return value
	return fallback
}

function isMonitorConfiguration(value: unknown): value is MonitorConfiguration {
	if (!isRecord(value))
		return false

	return typeof value.name === "string" && typeof value.disabled === "boolean"
}

function getPanelMaxHz(): number {
	const fallback = ASUS_HZ_PRESETS[ASUS_HZ_PRESETS.length - 1]
	const panel = getPanel()
	if (!panel)
		return fallback

	const modeHz = (panel.availableModes ?? [])
		.map(parseModeRefreshRate)
		.filter((hz): hz is number => hz !== null)

	const maxFromModes = modeHz.length > 0 ? Math.max(...modeHz) : 0
	const detectedMax = Math.floor(Math.max(maxFromModes, panel.refreshRate || 0))

	return detectedMax > 0 ? detectedMax : fallback
}


namespace Asusctl {
	export type Profile = "Performance" | "Balanced" | "Quiet"
	export type Mode = "Hybrid" | "Integrated"
}

@register()
class Asusctl extends GObject.Object {
	// Owns optional ASUS command integration and monitor-setting subscriptions.
	declare static $gtype: GObject.GType<Asusctl>
	static instance: Asusctl

	static get_default() {
		return this.instance ??= new Asusctl()
	}

	#profile: Asusctl.Profile
	#mode: Asusctl.Mode
	#available: boolean
	#optionDisposers: Array<() => void>

	constructor() {
		super()

		this.#profile = "Balanced"
		this.#mode = "Hybrid"
		this.#available = hasProgram("asusctl")
		this.#optionDisposers = []

		if (this.#available)
			void this.#initializeAvailability()
	}

	async #initializeAvailability() {
		const error = await this.#initialize()
		if (error instanceof Error)
			this.#fail("initialize: Failed to initialize asusctl", error)
	}

	#fail(context: string, error: Error) {
		console.error(`asusctl.${context}`, error)
		if (this.#available) {
			this.#available = false
			this.notify("available")
		}
	}

	@getter(Array)
	get profiles(): Asusctl.Profile[] {
		return ["Performance", "Balanced", "Quiet"]
	}

	@getter(Array)
	get resolutions(): string[] {
		const resolutions = getPanelResolutions()
		return resolutions.length > 0 ? resolutions : [options.asus.resolution.peek()]
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

		const error = await runCommand(["asusctl", "profile", "set", p])
		if (error instanceof Error)
			return this.#fail("setProfile: Failed to set profile", error)

		this.#profile = p
		this.notify("profile")
		void this.#updateMonitorConfiguration()
	}

	readonly nextProfile = async () => {
		if (!this.#available) return

		const cycle = await runCommand(["asusctl", "profile", "next"])
		if (cycle instanceof Error)
			return this.#fail("nextProfile: Failed to cycle profile", cycle)

		const output = await runCommand(["asusctl", "profile", "get"])
		if (output instanceof Error)
			return this.#fail("nextProfile: Failed to read profile", output)

		const match = output.match(/Active profile:\s*(\w+)/)
		const profile = parseProfile(match?.[1] ?? "")
		if (profile instanceof Error)
			return this.#fail("nextProfile: Failed to parse profile", profile)

		this.#profile = profile
		this.notify("profile")
		void this.#updateMonitorConfiguration()
	}

	readonly nextMode = async () => {
		if (!this.#available) return

		let nextMode: Asusctl.Mode = "Hybrid"
		if (this.#mode === "Hybrid")
			nextMode = "Integrated"

		const setMode = await runCommand(["supergfxctl", "-m", nextMode])
		if (setMode instanceof Error)
			return this.#fail("nextMode: Failed to set mode", setMode)

		const output = await runCommand(["supergfxctl", "-g"])
		if (output instanceof Error)
			return this.#fail("nextMode: Failed to read mode", output)

		const mode = parseMode(output)
		if (mode instanceof Error)
			return this.#fail("nextMode: Failed to parse mode", mode)

		this.#mode = mode
		this.notify("mode")
	}

	async #updateMonitorConfiguration() {
		if (!this.#available) return
		const output = await runCommand(["hyprctl", "monitors", "all", "-j"])
		if (output instanceof Error) {
			console.error("asusctl.updateMonitorConfiguration: Failed to read monitors", output)
			return
		}

		const parseResult = attempt((): unknown => JSON.parse(output))
		if (!parseResult.ok) {
			console.error("asusctl.updateMonitorConfiguration: Failed to parse monitors", parseResult.err)
			return
		}
		const parsed = parseResult.value
		if (!Array.isArray(parsed))
			return

		const panel = parsed.filter(isMonitorConfiguration).find(monitor => monitor.name === "eDP-1")
		if (panel?.disabled) return

		const maxHz = getPanelMaxHz()

		const availableResolutions = getPanelResolutions()
		let resolution = options.asus.resolution.peek()
		if (availableResolutions.length > 0 && !availableResolutions.includes(resolution)) {
			resolution = availableResolutions[0]
			options.asus.resolution.set(resolution)
		}
		const acHz = normalizeAsusHz(options.asus.ac_hz.peek(), maxHz)
		const batHz = normalizeAsusHz(options.asus.bat_hz.peek(), maxHz)

		if (acHz !== options.asus.ac_hz.peek())
			options.asus.ac_hz.set(acHz)
		if (batHz !== options.asus.bat_hz.peek())
			options.asus.bat_hz.set(batHz)

		let refreshRate = acHz
		if (this.#profile === "Quiet")
			refreshRate = batHz
		hyprland.message_async(`keyword monitor eDP-1,${resolution}@${refreshRate},0x0,1`, null)
	}

	async #initialize(): Promise<void | Error> {
		const profileOutput = await runCommand(["asusctl", "profile", "get"])
		if (profileOutput instanceof Error)
			return profileOutput

		const match = profileOutput.match(/Active profile: (\w+)/)
		const profile = parseProfile(match?.[1] ?? "")
		if (profile instanceof Error)
			return profile

		this.#profile = profile
		this.notify("profile")

		if (hasProgram("supergfxctl")) {
			const modeOutput = await runCommand(["supergfxctl", "-g"])
			if (modeOutput instanceof Error) {
				console.error("asusctl.initialize: Failed to read mode", modeOutput)
			} else {
				const mode = parseMode(modeOutput)
				if (mode instanceof Error) {
					console.error("asusctl.initialize: Failed to parse mode", mode)
				} else {
					this.#mode = mode
					this.notify("mode")
				}
			}
		}

		void this.#updateMonitorConfiguration()

		this.#optionDisposers.push(
			options.asus.resolution.subscribe(() => this.#updateMonitorConfiguration()),
			options.asus.ac_hz.subscribe(() => this.#updateMonitorConfiguration()),
			options.asus.bat_hz.subscribe(() => this.#updateMonitorConfiguration()),
		)
	}

	vfunc_finalize() {
		for (const dispose of this.#optionDisposers) dispose()
		this.#optionDisposers = []
		super.vfunc_finalize()
	}
}

export const asusctl = Asusctl.get_default()
