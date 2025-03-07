import { register, GObject, GLib, interval, AstalIO, property, execAsync } from "astal"
import { bash, dependencies, ensureDir, notify } from "../lib/utils"
import { env } from "../lib/environment"
import icons from "../lib/icons"

const now = () => GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S")

@register()
export default class Capturer extends GObject.Object {
	static instance: Capturer
	static get_default() {
		if (!this.instance)
			this.instance = new Capturer()

		return this.instance
	}

	#recordings = `${env.paths.home}/Videos/Screencasting`
	#screenshots = `${env.paths.home}/Pictures/Screenshots`
	recording_file = ""
	screenshot_file = ""
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

	async screenshot(select: boolean = false) {
		if (select && await bash("pidof slurp")) {
			return
		} else if (select && !dependencies("wayshot", "slurp")) {
			return
		} else if (!dependencies("wayshot")) {
			return
		}

		ensureDir(this.#screenshots)
		this.screenshot_file = `${this.#screenshots}/${now()}.png`

		const area = select ? await bash("slurp").catch(() => "").then(o => o && `-s "${o}"`) : ""
		if (select && !area) return

		await execAsync(`wayshot -f "${this.screenshot_file}" ${area}`)
		bash(`wl-copy < "${this.screenshot_file}"`)

		notify({
			appIcon: icons.fallback.image,
			appName: "Screenshot",
			summary: "Screenshot taken",
			body: `${this.screenshot_file}`,
			hints: {
				"string:image-path": this.screenshot_file,
			},
			actions: {
				"Show in Files": `bash -c 'xdg-open "${this.#screenshots}"'`,
				"View": `bash -c 'xdg-open "${this.screenshot_file}"'`,
				"Edit": `swappy -f "${this.screenshot_file}"`,
			},
		})
	}

	async startRecord(select: boolean = false) {
		if (select && !dependencies("wf-recorder", "slurp")) {
			return
		} else if (!dependencies("wf-recorder")) {
			return
		}

		if (this.#recording) return

		ensureDir(this.#recordings)
		this.recording_file = `"${this.#recordings}/${now()}.mkv"`

		const area = select ? await bash("slurp").catch(() => "").then(o => o && `-g "${o}"`) : ""
		if (select && !area) return
		execAsync(`wf-recorder ${area} -f ${this.recording_file} --pixel-format yuv420p`)

		this.#recording = true
		this.notify("recording")

		this.#timer = 0
		this.#interval = interval(1000, () => {
			this.notify("timer")
			this.#timer++
		})
	}

	async stopRecord() {
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
			body: `${this.recording_file}`,
			actions: {
				"Show in Files": `bash -c 'xdg-open "${this.#recordings}"'`,
				"View": `bash -c 'xdg-open "${this.recording_file}"'`,
			},
		})
	}
}
