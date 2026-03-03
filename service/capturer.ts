import GObject, { getter, register } from "ags/gobject"
import { execAsync } from "ags/process"
import { interval } from "ags/time"

import AstalIO from "gi://AstalIO"
import GLib from "gi://GLib"

import env from "$lib/env"
import { attemptAsync } from "$lib/result"
import { ensurePath } from "$lib/files"
import { dependencies, notify } from "$lib/utils"
import icons from "$lib/icons"

const createCaptureTimestamp = () => GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S")

@register()
export default class Capturer extends GObject.Object {
	declare static $gtype: GObject.GType<Capturer>
	static instance: Capturer

	static get_default() {
		return this.instance ??= new Capturer()
	}

	#recordings: string
	#screenshots: string
	#interval: AstalIO.Time
	#recording: boolean
	#timer: number
	#recordingFile: string
	#screenshotFile: string

	constructor() {
		super()

		this.#recordings = `${env.paths.home}/Videos/Screencasting/`
		this.#screenshots = `${env.paths.home}/Pictures/Screenshots/`
		this.#interval = new AstalIO.Time()
		this.#recording = false
		this.#timer = 0
		this.#recordingFile = ""
		this.#screenshotFile = ""
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
		if (!dependencies("hyprctl")) return null
		const result = await attemptAsync(async () => {
			const monitors = JSON.parse(await execAsync(["hyprctl", "monitors", "-j"]))
			return Array.isArray(monitors) ? monitors.find((m: any) => m?.focused) ?? null : null
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
			ensurePath(this.#screenshots)
			this.#screenshotFile = `${this.#screenshots}${createCaptureTimestamp()}.png`

			if (select) {
				const area = await this.#prepareCapture(true, "grim")
				if (!area) return
				await execAsync(["grim", "-g", area, this.#screenshotFile])
			} else {
				if (!dependencies("grim")) return
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
		const result = await attemptAsync(async () => {
			ensurePath(this.#recordings)
			this.#recordingFile = `${this.#recordings}${createCaptureTimestamp()}.mkv`

			const area = await this.#prepareCapture(select, "wf-recorder")
			if (select && !area) return

			const args = ["wf-recorder"]
			if (area)
				args.push("-g", area)
			args.push("-f", this.#recordingFile, "--pixel-format", "yuv420p")
			void execAsync(args)

			this.#recording = true
			this.notify("recording")

			this.#timer = 0
			this.#interval = interval(1000, () => {
				this.notify("timer")
				this.#timer++
			})
		})
		if (!result.ok)
			console.error("capturer.startRecord: Failed to start recording", result.err)
	}

	readonly stopRecord = async () => {
		const result = await attemptAsync(async () => {
			if (!this.#recording)
				return

			await execAsync(["pkill", "--signal", "SIGINT", "wf-recorder"]).catch(() => null)
			this.#recording = false
			this.notify("recording")
			this.#interval.cancel()

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
		})
		if (!result.ok)
			console.error("capturer.stopRecord: Failed to stop recording", result.err)
	}

	readonly #prepareCapture = async (select: boolean, mainTool: string) => {
		if (select) {
			const slurpRunning = await execAsync(["pidof", "slurp"]).catch(() => "")
			if (slurpRunning) return null
			if (!dependencies(mainTool, "slurp")) return null
			return await execAsync(["slurp"]).catch(() => "") || null
		}

		if (!dependencies(mainTool)) return ""
		return await this.#getFocusedScreenArea()
	}
}
