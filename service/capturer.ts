// Takes screenshots, starts and stops recordings, and tracks recording time.

import GObject, { getter, register } from "ags/gobject"
import { execAsync, Process, subprocess } from "ags/process"
import { interval, Timer } from "ags/time"
import app from "ags/gtk4/app"

import GLib from "gi://GLib"

import env from "$lib/env"
import { attemptAsync } from "$lib/result"
import { ensureDirectory } from "$lib/files"
import { notify } from "$lib/notifications"
import { requirePrograms } from "$lib/programs"
import icons from "$lib/icons"

const createCaptureTimestamp = () => GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S")

type HyprlandMonitorJson = {
	focused: boolean
	x: unknown
	y: unknown
	width: unknown
	height: unknown
	name?: unknown
}

function isHyprlandMonitorJson(value: unknown): value is HyprlandMonitorJson {
	if (value === null || typeof value !== "object") return false
	const monitor = value as Record<string, unknown>
	return typeof monitor.focused === "boolean"
		&& "x" in monitor
		&& "y" in monitor
		&& "width" in monitor
		&& "height" in monitor
}

@register()
class Capturer extends GObject.Object {
	declare static $gtype: GObject.GType<Capturer>
	static instance: Capturer

	static get_default() {
		return this.instance ??= new Capturer()
	}

	#recordings: string
	#screenshots: string
	#interval: Timer | null
	#recorder: Process | null
	#startingRecord: boolean
	#shuttingDown: boolean
	#notifySavedOnExit: boolean
	#shutdownSignalId: number
	#recording: boolean
	#timer: number
	#recordingFile: string
	#screenshotFile: string

	constructor() {
		super()

		this.#recordings = `${env.paths.home}/Videos/Screencasting/`
		this.#screenshots = `${env.paths.home}/Pictures/Screenshots/`
		this.#interval = null
		this.#recorder = null
		this.#startingRecord = false
		this.#shuttingDown = false
		this.#notifySavedOnExit = false
		this.#recording = false
		this.#timer = 0
		this.#recordingFile = ""
		this.#screenshotFile = ""
		this.#shutdownSignalId = app.connect("shutdown", () => this.#shutdown())
	}

	@getter(Number)
	get timer() {
		return this.#timer
	}

	@getter(Boolean)
	get recording() {
		return this.#recording
	}

	readonly #getFocusedMonitor = async () => {
		if (!requirePrograms("hyprctl")) return null
		const result = await attemptAsync(async () => {
			const parsed: unknown = JSON.parse(await execAsync(["hyprctl", "monitors", "-j"]))
			return Array.isArray(parsed)
				? parsed.find((monitor): monitor is HyprlandMonitorJson => isHyprlandMonitorJson(monitor) && monitor.focused) ?? null
				: null
		})
		return result.ok ? result.value : null
	}

	readonly #getFocusedScreenArea = async () => {
		const focused = await this.#getFocusedMonitor()
		if (!focused) return ""
		const x = Number(focused.x)
		const y = Number(focused.y)
		const width = Number(focused.width)
		const height = Number(focused.height)
		if (![x, y, width, height].every(Number.isFinite)) return ""
		return `${x},${y} ${width}x${height}`
	}

	readonly #getFocusedOutputName = async () => {
		const focused = await this.#getFocusedMonitor()
		const name = focused?.name
		return typeof name === "string" ? name : ""
	}

	readonly screenshot = async (select = false) => {
		const result = await attemptAsync(async () => {
			ensureDirectory(this.#screenshots)
			this.#screenshotFile = `${this.#screenshots}${createCaptureTimestamp()}.png`

			if (select) {
				const area = await this.#prepareCapture(true, "grim")
				if (!area) return
				await execAsync(["grim", "-g", area, this.#screenshotFile])
			} else {
				if (!requirePrograms("grim")) return
				const focusedOutput = await this.#getFocusedOutputName()
				const args = ["grim"]
				if (focusedOutput)
					args.push("-o", focusedOutput)
				args.push(this.#screenshotFile)
				await execAsync(args)
			}

			execAsync(["bash", "-c", `wl-copy --type image/png < "${this.#screenshotFile}"`]).catch(() => null)

			notify({
				appIcon: icons.fallback.image,
				appName: "Screenshot",
				summary: "Screenshot taken",
				body: this.#screenshotFile,
				previewImage: this.#screenshotFile,
				actions: {
					"Show in Files": `bash -c 'xdg-open "${this.#screenshots}"'`,
					"View": `bash -c 'xdg-open "${this.#screenshotFile}"'`,
					"Edit": `swappy -f "${this.#screenshotFile}"`,
				},
			})
		})
		if (!result.ok)
			console.error("capturer.screenshot: Failed to take screenshot", result.err)
	}

	readonly startRecord = async (select: boolean = false) => {
		if (this.#recorder || this.#startingRecord || this.#shuttingDown) return
		this.#startingRecord = true
		const result = await attemptAsync(async () => {
			ensureDirectory(this.#recordings)
			this.#recordingFile = `${this.#recordings}${createCaptureTimestamp()}.mkv`

			const area = await this.#prepareCapture(select, "wf-recorder")
			if (this.#shuttingDown || (select && !area)) return

			const args = ["wf-recorder"]
			if (area)
				args.push("-g", area)
			args.push("-f", this.#recordingFile, "--pixel-format", "yuv420p")
			const process = subprocess(args, () => { }, error =>
				console.error("capturer.recorder:", error),
			)
			this.#recorder = process
			process.connect("exit", (_process, code, signaled) => this.#onRecorderExit(process, code, signaled))

			this.#recording = true
			this.notify("recording")

			this.#timer = 0
			this.#interval?.cancel()
			this.#interval = interval(1000, () => {
				this.notify("timer")
				this.#timer++
			})
		})
		this.#startingRecord = false
		if (!result.ok)
			console.error("capturer.startRecord: Failed to start recording", result.err)
	}

	readonly stopRecord = async () => {
		const result = await attemptAsync(async () => {
			if (!this.#recording || !this.#recorder)
				return

			this.#notifySavedOnExit = true
			this.#recorder.signal(2)
		})
		if (!result.ok)
			console.error("capturer.stopRecord: Failed to stop recording", result.err)
	}

	readonly #prepareCapture = async (select: boolean, mainTool: string) => {
		if (select) {
			const slurpRunning = await execAsync(["pidof", "slurp"]).catch(() => "")
			if (slurpRunning) return null
			if (!requirePrograms(mainTool, "slurp")) return null
			return await execAsync(["slurp"]).catch(() => "") || null
		}

		if (!requirePrograms(mainTool)) return ""
		return await this.#getFocusedScreenArea()
	}

	#onRecorderExit(process: Process, code: number, signaled: boolean) {
		if (this.#recorder !== process) return
		this.#recorder = null
		this.#interval?.cancel()
		this.#interval = null
		if (this.#recording) {
			this.#recording = false
			this.notify("recording")
		}

		if (this.#notifySavedOnExit) {
			this.#notifySavedOnExit = false
			notify({
				appIcon: icons.fallback.video,
				appName: "Recorder",
				summary: "Recording saved",
				body: this.#recordingFile,
				actions: {
					"Show in Files": `bash -c 'xdg-open "${this.#recordings}"'`,
					"View": `bash -c 'xdg-open "${this.#recordingFile}"'`,
				},
			})
		} else if (code !== 0 || signaled) {
			console.error(`capturer.recorder: Exited with ${signaled ? "signal" : "status"} ${code}`)
		}
	}

	#shutdown() {
		this.#shuttingDown = true
		this.#notifySavedOnExit = false
		this.#interval?.cancel()
		this.#interval = null
		this.#recorder?.signal(2)
	}

	vfunc_finalize() {
		this.#shutdown()
		if (this.#shutdownSignalId) {
			app.disconnect(this.#shutdownSignalId)
			this.#shutdownSignalId = 0
		}
		super.vfunc_finalize()
	}
}

export const capturer = Capturer.get_default()
