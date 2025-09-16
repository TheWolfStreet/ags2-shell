import GObject, { getter, register } from "ags/gobject"
import { interval } from "ags/time"
import { execAsync } from "ags/process"

import AstalIO from "gi://AstalIO"
import GLib from "gi://GLib"

import { bash, dependencies, ensurePath, notify } from "$lib/utils"
import env from "$lib/env"
import icons from "$lib/icons"

const now = () => GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S")

@register()
export default class Capturer extends GObject.Object {
	static instance: Capturer

	static get_default() {
		return this.instance ??= new Capturer()
	}

	#recordings = `${env.paths.home}/Videos/Screencasting`
	#screenshots = `${env.paths.home}/Pictures/Screenshots`
	recFile = ""
	scrFile = ""
	#interval = new AstalIO.Time
	#recording = false
	#timer = 0

	@getter(Number)
	get timer() {
		return this.#timer
	}

	@getter(Boolean)
	get recording() {
		return this.#recording
	}

	readonly screenshot = async (select = false) => {
		if (select) {
			if (await bash("pidof slurp")) return
			if (!dependencies("wayshot", "slurp")) return
		} else if (!dependencies("wayshot")) return

		ensurePath(this.#screenshots)
		this.scrFile = `${this.#screenshots}/${now()}.png`

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
	}

	readonly startRecord = async (select: boolean = false) => {
		if (select && !dependencies("wf-recorder", "slurp")) {
			return
		} else if (!dependencies("wf-recorder")) {
			return
		}

		if (this.#recording) return

		ensurePath(this.#recordings)
		this.recFile = `"${this.#recordings}/${now()}.mkv"`

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
	}

	readonly stopRecord = async () => {
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
	}

}
