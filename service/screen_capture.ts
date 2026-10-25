import GObject, { getter, register } from "ags/gobject"
import { Process, subprocess } from "ags/process"
import { interval, type timer } from "$lib/time"
import app from "$lib/app"

import GLib from "gi://GLib"
import Gio from "gi://Gio"

import env from "$lib/env"
import { attempt, err, log_error, ok, type result } from "$lib/result"
import { ensure_directory, file_size } from "$lib/files"
import { run_command } from "$lib/commands"
import { copy_to_clipboard } from "$lib/clipboard"
import { hyprland } from "$lib/hyprland"
import { notify, notify_missing_programs } from "$lib/notifications"
import icons from "$lib/icons"
import { describe_exit } from "$lib/text"

type capture_options = { scope?: "focused" | "area" }

export const capture_kinds = {
	screenshot: {
		app_name: "Screenshot",
		summary: "Screenshot taken",
		directory: `${env.paths.home}/Pictures/Screenshots/`,
	},
	recording: {
		app_name: "Recorder",
		summary: "Recording saved",
		directory: `${env.paths.home}/Videos/Screencasting/`,
	},
}

const screenshots_directory = capture_kinds.screenshot.directory
const recordings_directory = capture_kinds.recording.directory
const cancelled = ok("cancelled" as const)

function create_capture_timestamp() {
	return `${GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S")}-${GLib.uuid_string_random()}`
}

function focused_output_arguments(): result<string[]> {
	const name = hyprland.focusedMonitor?.name
	if (!name) return err(new Error("No focused output"))
	return ok(["-o", name])
}

function exit_result(code: number, signaled: boolean): result<void> {
	if (code === 0 && !signaled) return ok(undefined)
	return err(new Error(`Recorder exited with ${describe_exit(code, signaled)}`))
}

function force_exit(recorder: Process) {
	log_error(
		attempt(() => recorder.kill()),
		"screen_capture.shutdown: Failed to force recorder exit",
	)
}

async function capture_screenshot(args: string[]): Promise<result<"captured">> {
	const screenshot_file = `${screenshots_directory}${create_capture_timestamp()}.png`
	const captured = await run_command([...args, screenshot_file])
	if (!captured.ok) return captured

	const copied = await copy_to_clipboard({
		path: screenshot_file,
		mime_type: "image/png",
	})
	log_error(
		copied,
		"screen_capture.screenshot: Saved screenshot but failed to copy it",
	)

	const sent = await notify({
		app_icon: icons.fallback.image,
		app_name: capture_kinds.screenshot.app_name,
		summary: capture_kinds.screenshot.summary,
		body: "Saved to Pictures/Screenshots",
		preview_image: screenshot_file,
		actions: [
			{ label: "Show in Files", argv: ["xdg-open", screenshots_directory] },
			{ label: "View", argv: ["xdg-open", screenshot_file] },
			{ label: "Edit", argv: ["swappy", "-f", screenshot_file] },
		],
	})
	log_error(sent, "screen_capture.screenshot: Failed to notify")
	return ok("captured" as const)
}

function notify_recording_saved(file: string) {
	void notify({
		app_icon: icons.fallback.video,
		app_name: capture_kinds.recording.app_name,
		summary: capture_kinds.recording.summary,
		body: file,
		actions: [
			{ label: "Show in Files", argv: ["xdg-open", recordings_directory] },
			{ label: "View", argv: ["xdg-open", file] },
		],
	}).then((sent) =>
		log_error(sent, "screen_capture.recorder: Failed to notify"),
	)
}

function finish_selection(
	process: Gio.Subprocess,
	response: Gio.AsyncResult,
): string {
	const [, out] = process.communicate_utf8_finish(response)
	if (!process.get_successful()) return ""
	return out.trim()
}

function read_selection(process: Gio.Subprocess): Promise<result<string>> {
	return new Promise((resolve) => {
		const started = attempt(() =>
			process.communicate_utf8_async(null, null, (_source, response) =>
				resolve(attempt(() => finish_selection(process, response))),
			),
		)
		if (!started.ok) resolve(started)
	})
}

function wait_for_exit(
	recorder: Process,
	interrupt: boolean,
): Promise<result<void>> {
	return new Promise((resolve) => {
		let finished = false
		const stop_listening = () => {
			finished = true
			recorder.disconnect(handler)
		}
		const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
			if (finished) return GLib.SOURCE_REMOVE
			stop_listening()
			force_exit(recorder)
			resolve(err(new Error("Recorder did not exit after SIGINT")))
			return GLib.SOURCE_REMOVE
		})
		const handler = recorder.connect("exit", (_process, code, signaled) => {
			if (finished) return
			stop_listening()
			GLib.Source.remove(deadline)
			resolve(exit_result(code, signaled))
		})
		if (!interrupt) return
		const interrupted = attempt(() => recorder.signal(2))
		if (interrupted.ok) return
		force_exit(recorder)
		log_error(interrupted, "screen_capture.shutdown: Failed to signal recorder")
	})
}

@register()
class ScreenCaptureService extends GObject.Object {
	declare static $gtype: GObject.GType<ScreenCaptureService>

	#interval: timer | null = null
	#recorder: Process | null = null
	#recording_start_pending = false
	#start_revision = 0
	#selection: { process: Gio.Subprocess; for_recording: boolean } | null = null
	#shutting_down = false
	#notify_saved_on_exit = false
	#stop_requested = false
	#shutdown_pending: Promise<result<void>> | null = null
	#shutdown_signal_id: number
	#timer = 0
	#recording_file = ""

	constructor() {
		super()

		this.#shutdown_signal_id = app.connect("shutdown", () => {
			void this.shutdown().then((result) =>
				log_error(result, "screen_capture.shutdown: Failed to stop recorder"),
			)
		})
	}

	@getter(Number)
	get timer() {
		return this.#timer
	}

	@getter(Boolean)
	get recording() {
		return this.#recorder !== null
	}

	@getter(Boolean)
	get starting() {
		return this.#recording_start_pending
	}

	async screenshot({ scope = "focused" }: capture_options = {}): Promise<
		result<"captured" | "cancelled">
	> {
		if (this.#shutting_down) return cancelled
		const target = await this.#screenshot_arguments(scope)
		if (!target.ok) return target
		if (!target.value) return cancelled
		const ready = ensure_directory(screenshots_directory)
		if (!ready.ok) return ready
		if (this.#shutting_down) return cancelled
		const captured = await capture_screenshot(["grim", ...target.value])
		log_error(captured, "screen_capture.screenshot: Failed to take screenshot")
		return captured
	}

	async start_recording({ scope = "focused" }: capture_options = {}): Promise<
		result<"started" | "cancelled">
	> {
		if (this.#recorder || this.#recording_start_pending || this.#shutting_down)
			return err(new Error("Recorder is already active or shutting down"))
		this.#recording_start_pending = true
		const revision = ++this.#start_revision
		this.notify("starting")
		try {
			return await this.#start(scope === "area", revision)
		} finally {
			this.#recording_start_pending = false
			this.notify("starting")
		}
	}

	stop_recording(): result<void> {
		const stopped = this.#request_stop()
		log_error(
			stopped,
			"screen_capture.stop_recording: Failed to stop recording",
		)
		return stopped
	}

	shutdown(): Promise<result<void>> {
		if (this.#shutdown_pending) return this.#shutdown_pending
		this.#shutdown_pending = this.#stop_for_shutdown()
		return this.#shutdown_pending
	}

	#superseded(revision: number | null) {
		if (this.#shutting_down) return true
		return revision !== null && revision !== this.#start_revision
	}

	async #screenshot_arguments(
		scope: capture_options["scope"],
	): Promise<result<string[] | null>> {
		if (scope === "area") return this.#area_arguments("grim")
		if (!notify_missing_programs("grim"))
			return err(new Error("grim is unavailable"))
		return focused_output_arguments()
	}

	async #recording_arguments(
		select: boolean,
		revision: number,
	): Promise<result<string[] | null>> {
		if (select) return this.#area_arguments("wf-recorder", revision)
		if (this.#superseded(revision)) return ok(null)
		return focused_output_arguments()
	}

	async #area_arguments(
		tool: string,
		revision: number | null = null,
	): Promise<result<string[] | null>> {
		const area = await this.#select_area(tool, revision)
		if (this.#superseded(revision)) return ok(null)
		if (!area.ok) return area
		if (!area.value) return ok(null)
		return ok(["-g", area.value])
	}

	async #start(
		select: boolean,
		revision: number,
	): Promise<result<"started" | "cancelled">> {
		if (!notify_missing_programs("wf-recorder"))
			return err(new Error("wf-recorder is unavailable"))
		const target = await this.#recording_arguments(select, revision)
		if (!target.ok) return target
		if (!target.value) return cancelled
		const ready = ensure_directory(recordings_directory)
		if (!ready.ok) return ready
		const launched = this.#launch_recorder(target.value)
		log_error(
			launched,
			"screen_capture.start_recording: Failed to start recording",
		)
		return launched
	}

	#launch_recorder(target: string[]): result<"started"> {
		const file = `${recordings_directory}${create_capture_timestamp()}.mkv`
		const spawned = attempt(() =>
			subprocess(
				["wf-recorder", ...target, "-f", file, "--pixel-format", "yuv420p"],
				() => {},
				(error) => console.error("screen_capture.recorder:", error),
			),
		)
		if (!spawned.ok) return spawned

		const process = spawned.value
		this.#recording_file = file
		this.#recorder = process
		this.notify("recording")
		process.connect("exit", (_process, code, signaled) =>
			log_error(
				attempt(() => this.#on_recorder_exit(process, code, signaled)),
				"screen_capture.recorder: Failed to handle recorder exit",
			),
		)
		this.#timer = 0
		this.#interval?.cancel()
		this.#interval = interval(1000, () => {
			this.#timer++
			this.notify("timer")
		})
		return ok("started" as const)
	}

	#request_stop(): result<void> {
		if (this.#recording_start_pending) {
			this.#start_revision++
			const selection = this.#selection
			return attempt(() => {
				if (selection?.for_recording) selection.process.force_exit()
			})
		}
		const recorder = this.#recorder
		if (!recorder || this.#stop_requested) return ok(undefined)
		const signaled = attempt(() => recorder.signal(2))
		if (!signaled.ok) return signaled
		this.#stop_requested = true
		this.#notify_saved_on_exit = true
		return ok(undefined)
	}

	async #select_area(
		tool: string,
		revision: number | null,
	): Promise<result<string | null>> {
		if (this.#superseded(revision)) return ok(null)
		if (!notify_missing_programs(tool, "slurp"))
			return err(new Error(`Missing ${tool} or slurp`))
		const slurp = await run_command(["pidof", "slurp"], { timeout_ms: 2000 })
		if (this.#superseded(revision)) return ok(null)
		const slurp_running = slurp.ok && slurp.value !== ""
		if (slurp_running || this.#selection)
			return err(new Error("Another area selection is active"))
		const spawned = attempt(() =>
			Gio.Subprocess.new(
				["slurp"],
				Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
			),
		)
		if (!spawned.ok) return spawned

		const process = spawned.value
		this.#selection = { process, for_recording: tool === "wf-recorder" }
		const selected = await read_selection(process)
		if (this.#selection?.process === process) this.#selection = null
		if (!selected.ok) return selected
		return ok(selected.value || null)
	}

	#on_recorder_exit(process: Process, code: number, signaled: boolean) {
		if (this.#recorder !== process) return
		this.#recorder = null
		this.#stop_requested = false
		this.#interval?.cancel()
		this.#interval = null
		this.notify("recording")

		const clean_exit = code === 0 && !signaled
		const size =
			this.#notify_saved_on_exit && clean_exit
				? file_size(this.#recording_file)
				: null
		if (size?.ok && size.value > 0) {
			this.#notify_saved_on_exit = false
			notify_recording_saved(this.#recording_file)
			return
		}
		if (this.#shutting_down && clean_exit) return
		this.#notify_saved_on_exit = false
		console.error(
			`screen_capture.recorder: Exited with ${describe_exit(code, signaled)}; output ${size?.ok ? size.value : "unavailable"}`,
		)
	}

	async #stop_for_shutdown(): Promise<result<void>> {
		this.#shutting_down = true
		this.#start_revision++
		const selection = attempt(() => this.#selection?.process.force_exit())
		log_error(selection, "screen_capture.shutdown: Failed to cancel selection")
		this.#notify_saved_on_exit = false
		this.#interval?.cancel()
		this.#interval = null
		const recorder = this.#recorder
		if (!recorder) return selection
		return wait_for_exit(recorder, !this.#stop_requested)
	}

	vfunc_finalize() {
		void this.shutdown().then((result) =>
			log_error(result, "screen_capture.finalize: Failed to stop recorder"),
		)
		if (this.#shutdown_signal_id) {
			app.disconnect(this.#shutdown_signal_id)
			this.#shutdown_signal_id = 0
		}
		super.vfunc_finalize()
	}
}

export const screen_capture = new ScreenCaptureService()
