import { register, GObject, GLib, interval, AstalIO, property, execAsync } from "astal"

import { bash, dependencies, ensureDir, notify } from "../lib/utils"
import { env } from "../lib/environment"
import icons from "../lib/icons"

const now = () => GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S")

@register()
export default class Recorder extends GObject.Object {
	static instance: Recorder
	static get_default() {
		if (!this.instance)
			this.instance = new Recorder()

		return this.instance
	}

	#recordings = `${env.paths.home}/Videos/Screencasting`
	#file = ""
	#interval = new AstalIO.Time
	#recording = false
	#timer = 0

	@property(Number)
	get timer() {
		return this.#timer
	}

	@property(Boolean)
	get recording() {
		return this.#recording
	}

	async start(select: boolean = false) {
		if (select && !dependencies("wf-recorder", "slurp")) {
			return
		} else if (!dependencies("wf-recorder")) {
			return
		}

		if (this.#recording) return

		ensureDir(this.#recordings)
		this.#file = `"${this.#recordings}/${now()}.mkv"`

		const area = select ? await bash("slurp").catch(() => "").then(o => o && `-g "${o}"`) : ""
		if (select && !area) return
		execAsync(`wf-recorder ${area} -f ${this.#file} --pixel-format yuv420p`)

		this.#recording = true
		this.notify("recording")

		this.#timer = 0
		this.#interval = interval(1000, () => {
			this.notify("timer")
			this.#timer++
		})
	}

	async stop() {
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
			body: `${this.#file}`,
			actions: {
				"Show in Files": `bash -c 'xdg-open "${this.#recordings}"'`,
				"View": `bash -c 'xdg-open "${this.#file}"'`,
			},
		})
	}
}
