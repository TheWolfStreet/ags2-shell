import GObject, { getter, register } from "ags/gobject"
import { execAsync, Process, subprocess } from "ags/process"
import { interval, timeout, type Timer } from "$lib/time"
import app from "$lib/app"

import GLib from "gi://GLib"
import Gio from "gi://Gio"

import env from "$lib/env"
import { attempt, attempt_async, err, log_error, ok, type Result } from "$lib/result"
import { ensure_directory } from "$lib/files"
import { notify, notify_missing_programs } from "$lib/notifications"
import icons from "$lib/icons"

const recordings_directory = `${env.paths.home}/Videos/Screencasting/`
const screenshots_directory = `${env.paths.home}/Pictures/Screenshots/`
const create_capture_timestamp = () =>
	`${GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S")}-${GLib.uuid_string_random()}`

type hyprland_monitor_json = {
	focused: boolean
	name?: unknown
}

function is_hyprland_monitor_json(value: unknown): value is hyprland_monitor_json {
	if (value === null || typeof value !== "object") return false
	const monitor = value as Record<string, unknown>
	return typeof monitor.focused === "boolean"
}

@register()
class ScreenCaptureService extends GObject.Object {
	declare static $gtype: GObject.GType<ScreenCaptureService>

	#interval: Timer | null = null
	#recorder: Process | null = null
	#recording_start_pending = false
	#start_revision = 0
	#selector: Gio.Subprocess | null = null
	#recording_selector: Gio.Subprocess | null = null
	#shutting_down = false
	#notify_saved_on_exit = false
	#stop_requested = false
	#shutdown_pending: Promise<Result<void>> | null = null
	#shutdown_signal_id: number
	#recording = false
	#timer = 0
	#recording_file = ""

	constructor() {
		super()

		this.#shutdown_signal_id = app.connect("shutdown", () => {
			void this.shutdown().then((result) =>
				log_error(result, "screenCapture.shutdown: Failed to stop recorder"))
		})
	}

	@getter(Number)
	get timer() {
		return this.#timer
	}

	@getter(Boolean)
	get recording() {
		return this.#recording
	}

	readonly #get_focused_monitor = async (): Promise<Result<hyprland_monitor_json>> => {
		if (!notify_missing_programs("hyprctl")) return err(new Error("hyprctl is unavailable"))
		const parsed = await attempt_async(async (): Promise<unknown> =>
			JSON.parse(await execAsync(["hyprctl", "monitors", "-j"])))
		if (!parsed.ok) return parsed
		if (!Array.isArray(parsed.value)) return err(new Error("Invalid monitor list"))
		const focused = parsed.value.find(
			(monitor): monitor is hyprland_monitor_json =>
				is_hyprland_monitor_json(monitor) && monitor.focused,
		)
		return focused ? ok(focused) : err(new Error("No focused output"))
	}

	readonly #get_focused_output_name = async (): Promise<Result<string>> => {
		const focused = await this.#get_focused_monitor()
		if (!focused.ok) return focused
		const name = focused.value.name
		return typeof name === "string" && name.length > 0
			? ok(name)
			: err(new Error("Focused output has no name"))
	}

	readonly screenshot = async ({ scope = "focused" }: { scope?: "focused" | "area" } = {}): Promise<Result<"captured" | "cancelled">> => {
		if (this.#shutting_down) return ok("cancelled" as const)
		let args: string[]
		if (scope === "area") {
			const area = await this.#select_area("grim")
			if (this.#shutting_down) return ok("cancelled" as const)
			if (!area.ok) return area
			if (!area.value) return ok("cancelled" as const)
			args = ["grim", "-g", area.value]
		} else {
			if (!notify_missing_programs("grim")) return err(new Error("grim is unavailable"))
			const focused_output = await this.#get_focused_output_name()
			if (this.#shutting_down) return ok("cancelled" as const)
			if (!focused_output.ok) return focused_output
			args = ["grim", "-o", focused_output.value]
		}
		const ready = ensure_directory(screenshots_directory)
		if (!ready.ok) return ready
		if (this.#shutting_down) return ok("cancelled" as const)
		const result = await attempt_async(async () => {
			const screenshot_file = `${screenshots_directory}${create_capture_timestamp()}.png`
			await execAsync([...args, screenshot_file])

			const copied = await attempt_async(() => new Promise<void>((resolve, reject) => {
				const process = Gio.Subprocess.new([
					"bash", "-c", `wl-copy --type image/png < ${GLib.shell_quote(screenshot_file)}`,
				], Gio.SubprocessFlags.NONE)
				const deadline = timeout(5000, () => process.force_exit())
				process.wait_check_async(null, (_source, response) => {
					deadline.cancel()
					try {
						if (!process.wait_check_finish(response)) throw new Error("Clipboard copy failed")
						resolve()
					} catch (error) { reject(error) }
				})
			}))
			log_error(copied, "screenCapture.screenshot: Saved screenshot but failed to copy it")

			const sent = await notify({
				app_icon: icons.fallback.image,
				app_name: "Screenshot",
				summary: "Screenshot taken",
				body: screenshot_file,
				preview_image: screenshot_file,
				actions: [
					{ label: "Show in Files", argv: ["xdg-open", screenshots_directory] },
					{ label: "View", argv: ["xdg-open", screenshot_file] },
					{ label: "Edit", argv: ["swappy", "-f", screenshot_file] },
				],
			})
			if (!sent.ok) console.error("screenCapture.screenshot: Failed to notify", sent.err)
			return "captured" as const
		})
		log_error(result, "screenCapture.screenshot: Failed to take screenshot")
		return result
	}

	readonly start_recording = async ({ scope = "focused" }: { scope?: "focused" | "area" } = {}): Promise<Result<"started" | "cancelled">> => {
		const select = scope === "area"
		if (this.#recorder || this.#recording_start_pending || this.#shutting_down)
			return err(new Error("Recorder is already active or shutting down"))
		this.#recording_start_pending = true
		const revision = ++this.#start_revision
		this.notify("starting")
		try {
			if (!notify_missing_programs("wf-recorder")) return err(new Error("wf-recorder is unavailable"))
			let area: string | null = null
			if (select) {
				const selected = await this.#select_area("wf-recorder", revision)
				if (!selected.ok) {
					if (revision !== this.#start_revision || this.#shutting_down) return ok("cancelled" as const)
					return selected
				}
				area = selected.value
			}
			if (this.#shutting_down || revision !== this.#start_revision || (select && !area)) return ok("cancelled" as const)

			const args = ["wf-recorder"]
			if (area) args.push("-g", area)
			else {
				const focused = await this.#get_focused_output_name()
				if (this.#shutting_down || revision !== this.#start_revision) return ok("cancelled" as const)
				if (!focused.ok) return focused
				args.push("-o", focused.value)
			}
			if (this.#shutting_down || revision !== this.#start_revision) return ok("cancelled" as const)
			const ready = ensure_directory(recordings_directory)
			if (!ready.ok) return ready
			const result = await attempt_async(async () => {
				const recording_file = `${recordings_directory}${create_capture_timestamp()}.mkv`
				args.push("-f", recording_file, "--pixel-format", "yuv420p")
				const process = subprocess(
					args,
					() => {},
					(error) => console.error("screenCapture.recorder:", error),
				)
				this.#recording_file = recording_file
				this.#recorder = process
				process.connect("exit", (source_process, code, signaled) => {
					const exited = attempt(() => this.#on_recorder_exit(process, code, signaled))
					if (!exited.ok)
						console.error("screenCapture.recorder: Failed to handle recorder exit", exited.err)
				})

				this.#recording = true
				this.notify("recording")
				this.#timer = 0
				this.#interval?.cancel()
				this.#interval = interval(1000, () => {
					this.#timer++
					this.notify("timer")
				})
				return "started" as const
			})
			log_error(result, "screenCapture.startRecording: Failed to start recording")
			return result
		} finally {
			this.#recording_start_pending = false
			this.notify("starting")
		}
	}

	@getter(Boolean)
	get starting() { return this.#recording_start_pending }

	readonly stop_recording = (): Result<void> => {
		const result = attempt(() => {
			if (this.#recording_start_pending) {
				this.#start_revision++
				this.#recording_selector?.force_exit()
				return
			}
			if (!this.#recording || !this.#recorder || this.#stop_requested) return
			this.#recorder.signal(2)
			this.#stop_requested = true
			this.#notify_saved_on_exit = true
		})
		log_error(result, "screenCapture.stopRecording: Failed to stop recording")
		return result
	}

	async #select_area(main_tool: string, revision: number | null = null): Promise<Result<string | null>> {
		if (this.#shutting_down || (revision !== null && revision !== this.#start_revision)) return ok(null)
		if (!notify_missing_programs(main_tool, "slurp")) return err(new Error(`Missing ${main_tool} or slurp`))
		const slurp_running = await execAsync(["pidof", "slurp"]).catch(() => "")
		if (this.#shutting_down || (revision !== null && revision !== this.#start_revision)) return ok(null)
		if (slurp_running || this.#selector) return err(new Error("Another area selection is active"))
		const selected = await attempt_async(async () => {
			const process = Gio.Subprocess.new(["slurp"], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
			this.#selector = process
			if (main_tool === "wf-recorder") this.#recording_selector = process
			try {
				return await new Promise<string>((resolve, reject) => {
					process.communicate_utf8_async(null, null, (source, response) => {
						try {
							const [, out] = process.communicate_utf8_finish(response)
							resolve(process.get_successful() ? out.trim() : "")
						} catch (error) { reject(error) }
					})
				})
			} finally {
				if (this.#selector === process) this.#selector = null
				if (this.#recording_selector === process) this.#recording_selector = null
			}
		})
		return selected.ok ? ok(selected.value || null) : selected
	}

	#on_recorder_exit(process: Process, code: number, signaled: boolean) {
		if (this.#recorder !== process) return
		this.#recorder = null
		this.#stop_requested = false
		this.#interval?.cancel()
		this.#interval = null
		if (this.#recording) {
			this.#recording = false
			this.notify("recording")
		}

		const file = this.#notify_saved_on_exit && code === 0 && !signaled
			? attempt(() => Gio.File.new_for_path(this.#recording_file).query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null).get_size())
			: null
		if (file?.ok && file.value > 0) {
			this.#notify_saved_on_exit = false
			void notify({
				app_icon: icons.fallback.video,
				app_name: "Recorder",
				summary: "Recording saved",
				body: this.#recording_file,
				actions: [
					{ label: "Show in Files", argv: ["xdg-open", recordings_directory] },
					{ label: "View", argv: ["xdg-open", this.#recording_file] },
				],
			}).then((result) => {
				if (!result.ok) console.error("screenCapture.recorder: Failed to notify", result.err)
			})
		} else if (!this.#shutting_down || code !== 0 || signaled) {
			this.#notify_saved_on_exit = false
			console.error(
				`screenCapture.recorder: Exited with ${signaled ? "signal" : "status"} ${code}; output ${file?.ok ? file.value : "unavailable"}`,
			)
		}
	}

	shutdown(): Promise<Result<void>> {
		if (this.#shutdown_pending) return this.#shutdown_pending
		this.#shutdown_pending = this.#stop_for_shutdown()
		return this.#shutdown_pending
	}

	async #stop_for_shutdown(): Promise<Result<void>> {
		this.#shutting_down = true
		this.#start_revision++
		const selection = attempt(() => this.#selector?.force_exit())
		if (!selection.ok) console.error("screenCapture.shutdown: Failed to cancel selection", selection.err)
		this.#notify_saved_on_exit = false
		this.#interval?.cancel()
		this.#interval = null
		const recorder = this.#recorder
		if (!recorder) return selection.ok ? ok(undefined) : selection
		return new Promise((resolve) => {
			let finished = false
			const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
				if (!finished) {
					finished = true
					recorder.disconnect(handler)
					const killed = attempt(() => recorder.kill())
					if (!killed.ok) console.error("screenCapture.shutdown: Failed to force recorder exit", killed.err)
					resolve(err(new Error("Recorder did not exit after SIGINT")))
				}
				return GLib.SOURCE_REMOVE
			})
			const handler = recorder.connect("exit", (source_process, code, signaled) => {
				if (finished) return
				finished = true
				GLib.Source.remove(deadline)
				recorder.disconnect(handler)
				resolve(code === 0 && !signaled ? ok(undefined) : err(new Error(`Recorder exited with ${signaled ? "signal" : "status"} ${code}`)))
			})
			if (this.#stop_requested) return
			const stopped = attempt(() => recorder.signal(2))
			if (!stopped.ok) {
				const killed = attempt(() => recorder.kill())
				if (!killed.ok) console.error("screenCapture.shutdown: Failed to force recorder exit", killed.err)
				console.error("screenCapture.shutdown: Failed to signal recorder", stopped.err)
			}
		})
	}

	vfunc_finalize() {
		void this.shutdown().then((result) =>
			log_error(result, "screenCapture.finalize: Failed to stop recorder"))
		if (this.#shutdown_signal_id) {
			app.disconnect(this.#shutdown_signal_id)
			this.#shutdown_signal_id = 0
		}
		super.vfunc_finalize()
	}
}

export const screen_capture = new ScreenCaptureService()
