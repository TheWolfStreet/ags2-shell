// Checks ASUS controls, reads and changes profiles and graphics modes, and applies screen settings.

import GObject, { getter, register, setter } from "ags/gobject"
import { execAsync } from "ags/process"

import { hyprland } from "$service/astal"
import { hasProgram } from "$lib/programs"
import { attempt, attemptAsync, err, ok, type Result } from "$lib/result"
import options from "$shell/options"

type MonitorConfiguration = {
	name: string
	disabled: boolean
	width: number
	height: number
	availableModes?: string[]
}

type MonitorMode = {
	resolution: string
	refreshRate: number
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

function parseMonitorMode(mode: string): MonitorMode | null {
	const match = mode.match(/^(\d+)x(\d+)\s*@\s*([0-9]+(?:\.[0-9]+)?)/)
	if (!match)
		return null

	const refreshRate = Number.parseFloat(match[3])
	return Number.isFinite(refreshRate) && refreshRate > 0
		? { resolution: `${match[1]}x${match[2]}`, refreshRate }
		: null
}

function isInternalPanel(name: string) {
	return /^(?:eDP|LVDS)-/i.test(name)
}

function selectPanel(monitors: MonitorConfiguration[]): MonitorConfiguration | undefined {
	return monitors.find(monitor => isInternalPanel(monitor.name))
}

function parsePanelModes(modes: string[]): MonitorMode[] {
	return modes.map(parseMonitorMode).filter((mode): mode is MonitorMode => mode !== null)
}

function readPanelConfiguration(): MonitorConfiguration | undefined {
	const result = attempt((): unknown => JSON.parse(hyprland.message("j/monitors all")))
	if (!result.ok || !Array.isArray(result.value))
		return undefined

	return selectPanel(result.value.filter(isMonitorConfiguration))
}

function getPanelModes(configuration = readPanelConfiguration()): MonitorMode[] {
	if (!configuration) return []
	const resolution = `${configuration.width}x${configuration.height}`
	return parsePanelModes(configuration.availableModes ?? [])
		.filter(mode => mode.resolution === resolution)
}

function uniqueRefreshRates(modes: MonitorMode[]): number[] {
	return [...new Set(modes.map(mode => Math.round(mode.refreshRate)))].sort((a, b) => a - b)
}

function nearestValue(values: number[], preferred: number): number {
	return values.reduce((nearest, value) =>
		Math.abs(value - preferred) < Math.abs(nearest - preferred) ? value : nearest,
	)
}

function normalizeRefreshRate(value: number, available: number[]): number {
	if (available.includes(value))
		return value
	return nearestValue(available, value)
}

function resolveRefreshRate(modes: MonitorMode[], preferred: number): number {
	const available = modes.map(mode => mode.refreshRate)
	return nearestValue(available, preferred)
}

function isMonitorConfiguration(value: unknown): value is MonitorConfiguration {
	if (!isRecord(value))
		return false

	return typeof value.name === "string"
		&& typeof value.disabled === "boolean"
		&& typeof value.width === "number"
		&& value.width > 0
		&& typeof value.height === "number"
		&& value.height > 0
		&& (value.availableModes === undefined
			|| (Array.isArray(value.availableModes) && value.availableModes.every(mode => typeof mode === "string")))
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
	#monitorUpdateSequence: number

	constructor() {
		super()

		this.#profile = "Balanced"
		this.#mode = "Hybrid"
		this.#available = hasProgram("asusctl")
		this.#optionDisposers = []
		this.#monitorUpdateSequence = 0

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
	get refreshRates(): number[] {
		return uniqueRefreshRates(getPanelModes())
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
		const sequence = ++this.#monitorUpdateSequence
		const output = await runCommand(["hyprctl", "monitors", "all", "-j"])
		if (sequence !== this.#monitorUpdateSequence) return
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

		const panel = selectPanel(parsed.filter(isMonitorConfiguration))
		if (!panel) return
		if (panel.disabled) return

		const panelModes = getPanelModes(panel)
		const availableRefreshRates = uniqueRefreshRates(panelModes)
		if (availableRefreshRates.length === 0) return
		const acHz = normalizeRefreshRate(options.asus.ac_hz.peek(), availableRefreshRates)
		const batHz = normalizeRefreshRate(options.asus.bat_hz.peek(), availableRefreshRates)

		if (acHz !== options.asus.ac_hz.peek())
			options.asus.ac_hz.set(acHz)
		if (batHz !== options.asus.bat_hz.peek())
			options.asus.bat_hz.set(batHz)
		if (sequence !== this.#monitorUpdateSequence) return

		const preferredRefreshRate = this.#profile === "Quiet" ? batHz : acHz
		const refreshRate = resolveRefreshRate(panelModes, preferredRefreshRate)
		const resolution = `${panel.width}x${panel.height}`
		hyprland.message_async(`keyword monitor ${panel.name},${resolution}@${refreshRate},0x0,1`, null)
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
