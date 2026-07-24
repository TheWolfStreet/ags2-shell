// Checks ASUS controls, reads and changes profiles and graphics modes, and applies screen settings.

import GObject, { getter, register, setter } from "ags/gobject"
import { execAsync } from "ags/process"

import { hyprland } from "$service/astal"
import { hasProgram } from "$lib/programs"
import { attempt, attemptAsync, err, ok, type Result } from "$lib/result"
import options from "options"

const ASUS_HZ_PRESETS = [60, 144, 240]

type MonitorConfiguration = {
	name: string
	disabled: boolean
}

async function runCommand(args: string[]): Promise<Result<string>> {
	const result = await attemptAsync(async () => execAsync(args))
	return result.ok
		? result
		: err(new Error(`Command failed: ${args.join(" ")}`, { cause: result.err }))
}

function parseProfile(raw: string): Result<Asusctl.Profile> {
	const value = raw.trim()
	if (value === "Performance" || value === "Balanced" || value === "Quiet")
		return ok(value)

	return err(new Error(`Unexpected profile value: ${value}`))
}

function parseMode(raw: string): Result<Asusctl.Mode> {
	const value = raw.trim()
	if (value === "Hybrid" || value === "Integrated")
		return ok(value)

	return err(new Error(`Unexpected mode value: ${value}`))
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
		const result = await this.#initialize()
		if (!result.ok)
			this.#fail("initialize: Failed to initialize asusctl", result.err)
	}

	#fail(context: string, error: unknown) {
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

		const result = await runCommand(["asusctl", "profile", "set", p])
		if (!result.ok)
			return this.#fail("setProfile: Failed to set profile", result.err)

		this.#profile = p
		this.notify("profile")
		void this.#updateMonitorConfiguration()
	}

	async #updateMonitorConfiguration() {
		if (!this.#available) return
		const output = await runCommand(["hyprctl", "monitors", "all", "-j"])
		if (!output.ok) {
			console.error("asusctl.updateMonitorConfiguration: Failed to read monitors", output.err)
			return
		}

		const parseResult = attempt((): unknown => JSON.parse(output.value))
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

	async #initialize(): Promise<Result<void>> {
		const profileOutput = await runCommand(["asusctl", "profile", "get"])
		if (!profileOutput.ok)
			return profileOutput

		const match = profileOutput.value.match(/Active profile: (\w+)/)
		const profile = parseProfile(match?.[1] ?? "")
		if (!profile.ok)
			return profile

		this.#profile = profile.value
		this.notify("profile")

		if (hasProgram("supergfxctl")) {
			const modeOutput = await runCommand(["supergfxctl", "-g"])
			if (!modeOutput.ok) {
				console.error("asusctl.initialize: Failed to read mode", modeOutput.err)
			} else {
				const mode = parseMode(modeOutput.value)
				if (!mode.ok) {
					console.error("asusctl.initialize: Failed to parse mode", mode.err)
				} else {
					this.#mode = mode.value
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
		return ok(undefined)
	}

	vfunc_finalize() {
		for (const dispose of this.#optionDisposers) dispose()
		this.#optionDisposers = []
		super.vfunc_finalize()
	}
}

export const asusctl = Asusctl.get_default()
