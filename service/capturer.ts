import GObject, { getter, register } from "ags/gobject"
import { interval } from "ags/time"
import { execAsync } from "ags/process"

import AstalIO from "gi://AstalIO"
import GLib from "gi://GLib"

import env from "$lib/env"
import { bash, dependencies, ensurePath, notify } from "$lib/utils"
import icons from "$lib/icons"

const now = () => GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S")

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
	recFile: string
	scrFile: string

	constructor() {
		super()

		this.#recordings = `${env.paths.home}/Videos/Screencasting/`
		this.#screenshots = `${env.paths.home}/Pictures/Screenshots/`
		this.#interval = new AstalIO.Time()
		this.#recording = false
		this.#timer = 0
		this.recFile = ""
		this.scrFile = ""
	}

	@getter(Number)
	get timer() {
		return this.#timer
	}

	@getter(Boolean)
	get recording() {
		return this.#recording
	}

	readonly screenshot = async (select = false) => {
		try {
			if (select) {
				if (await bash("pidof slurp")) return
				if (!dependencies("wayshot", "slurp")) return
			} else if (!dependencies("wayshot")) return

			ensurePath(this.#screenshots)
			this.scrFile = `${this.#screenshots}${now()}.png`

			const area = select ? await bash("slurp").catch(() => "") : ""
			if (select && !area) return

			await execAsync(`wayshot -f "${this.scrFile}"${area ? ` -s "${area}"` : ""}`)
			bash(`wl-copy < "${this.scrFile}"`)

			notify({
				appIcon: icons.fallback.image,
				appName: "Screenshot",
				summary: "Screenshot taken",
				body: this.scrFile,
				hints: { "string:image-path": this.scrFile },
				actions: {
					"Show in Files": `bash -c 'xdg-open "${this.#screenshots}"'`,
					"View": `bash -c 'xdg-open "${this.scrFile}"'`,
					"Edit": `swappy -f "${this.scrFile}"`,
				},
			})
		} catch (e) {
			console.error("Failed to take screenshot:", e)
		}
	}

	readonly startRecord = async (select: boolean = false) => {
		try {
			if (select && !dependencies("wf-recorder", "slurp")) {
				return
			} else if (!dependencies("wf-recorder")) {
				return
			}

			if (this.#recording) return

			ensurePath(this.#recordings)
			this.recFile = `"${this.#recordings}${now()}.mkv"`

			const area = select ? await bash("slurp").catch(() => "").then(o => o && `-g "${o}"`) : ""
			if (select && !area) return
			execAsync(`wf-recorder ${area} -f ${this.recFile} --pixel-format yuv420p`)

			this.#recording = true
			this.notify("recording")

			this.#timer = 0
			this.#interval = interval(1000, () => {
				this.notify("timer")
				this.#timer++
			})
		} catch (e) {
			console.error("Failed to start recording:", e)
		}
	}

	readonly stopRecord = async () => {
		try {
			if (!this.#recording)
				return

			await bash("pkill --signal SIGINT wf-recorder").catch(() => null)
			this.#recording = false
			this.notify("recording")
			this.#interval.cancel()

			notify({
				appIcon: icons.fallback.video,
				appName: "Recorder",
				summary: "Recording saved",
				body: `${this.recFile}`,
				actions: {
					"Show in Files": `bash -c 'xdg-open "${this.#recordings}"'`,
					"View": `bash -c 'xdg-open "${this.recFile}"'`,
				},
			})
		} catch (e) {
			console.error("Failed to stop recording:", e)
		}
	}

}
