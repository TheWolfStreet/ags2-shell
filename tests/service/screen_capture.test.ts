import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { load_module } from "../load_module.ts"
import { noop_timer, gobject_stub } from "../helpers.ts"

type fake_process = {
	args: string[]
	flags: number
	communicated: boolean
	callback?: (process: fake_process, result: object) => void
	force_exit(): void
	communicate_utf8_async(
		input: string | null,
		cancel: unknown,
		callback: (process: fake_process, result: object) => void,
	): void
	communicate_utf8_finish(): [boolean, string, string]
	get_successful(): boolean
}

type fake_notification = {
	body: string
	preview_image: string
	summary: string
}

type fake_recorder = {
	args: string[]
	signals: number[]
	kills: number
	handlers: Map<number, (...args: unknown[]) => void>
	connect(name: string, handler: (...args: unknown[]) => void): number
	disconnect(id: number): void
	signal(value: number): void
	kill(): void
	exit(code: number, signaled: boolean): void
}

function fake_recorder(args: string[]): fake_recorder {
	let next = 0
	return {
		args,
		signals: [],
		kills: 0,
		handlers: new Map(),
		connect(_name, handler) {
			this.handlers.set(++next, handler)
			return next
		},
		disconnect(id) {
			this.handlers.delete(id)
		},
		signal(value) {
			this.signals.push(value)
		},
		kill() {
			this.kills++
		},
		exit(code, signaled) {
			for (const handler of [...this.handlers.values()])
				handler(this, code, signaled)
		},
	}
}

async function service_fixture({
	copy_successful = true,
	capture_error = null as Error | null,
	finish_error = null as Error | null,
	start_error = null as Error | null,
	selection_successful = true,
	recording_size = 1024,
} = {}) {
	let resolve_pidof
	let hold_pidof = false
	const processes: fake_process[] = []
	const copies: unknown[] = []
	const commands: string[][] = []
	const notifications: fake_notification[] = []
	const errors: string[] = []
	const recorders: fake_recorder[] = []
	const deadlines = new Map<number, () => boolean>()
	const notified: string[] = []
	let next_deadline = 0
	const imports = {
		"ags/gobject": gobject_stub((name) => notified.push(name)),
		"$lib/commands": {
			communicate: (
				await load_module("lib/commands.ts", {
					"gi://Gio": { default: {} },
					"gi://GLib": { default: {} },
				})
			).communicate,
			run_command: (args: string[]) => {
				commands.push(args)
				if (args[0] === "grim" && capture_error)
					return Promise.resolve({ ok: false, err: capture_error })
				if (args[0] === "pidof" && hold_pidof)
					return new Promise((resolve) => {
						resolve_pidof = (value: string) => resolve({ ok: true, value })
					})
				return Promise.resolve({ ok: true, value: "" })
			},
		},
		"$lib/hyprland": { hyprland: { focusedMonitor: { name: "DP-1" } } },
		"ags/process": {
			Process: class {},
			subprocess: (args: string[]) => {
				const recorder = fake_recorder(args)
				recorders.push(recorder)
				return recorder
			},
		},
		"$lib/time": {
			interval: noop_timer,
			timeout: noop_timer,
		},
		"$lib/app": {
			default: {
				connect: () => 1,
				disconnect() {},
			},
		},
		"gi://GLib": {
			default: {
				DateTime: { new_now_local: () => ({ format: () => "time" }) },
				uuid_string_random: () => "uuid",
				shell_quote: (value) => `'${value}'`,
				PRIORITY_DEFAULT: 0,
				SOURCE_REMOVE: false,
				timeout_add: (_priority, _ms, callback) => {
					deadlines.set(++next_deadline, callback)
					return next_deadline
				},
				Source: {
					remove: (id: number) => deadlines.delete(id),
				},
			},
		},
		"gi://Gio": {
			default: {
				SubprocessFlags: { NONE: 0, STDOUT_PIPE: 1, STDERR_PIPE: 2 },
				Subprocess: {
					new: (args, flags) => {
						const process: fake_process = {
							args,
							flags,
							communicated: false,
							force_exit() {
								this.callback?.(this, {})
							},
							communicate_utf8_async(_input, _cancel, callback) {
								if (start_error) throw start_error
								this.communicated = true
								this.callback = callback
							},
							communicate_utf8_finish() {
								if (finish_error) throw finish_error
								return [true, "10,20 30x40", ""]
							},
							get_successful() {
								return selection_successful
							},
						}
						processes.push(process)
						return process
					},
				},
			},
		},
		"$lib/env": { default: { paths: { home: "/test" } } },
		"$lib/files": {
			ensure_directory: () => ({ ok: true }),
			file_size: () => ({ ok: true, value: recording_size }),
		},
		"$lib/clipboard": {
			copy_to_clipboard: async (content: unknown) => {
				copies.push(content)
				return copy_successful
					? { ok: true, value: undefined }
					: { ok: false, err: new Error("wl-copy failed") }
			},
		},
		"$lib/notifications": {
			notify: async (value) => {
				notifications.push(value)
				return { ok: true }
			},
			notify_missing_programs: () => true,
		},
		"$lib/icons": { default: { fallback: { image: "image", video: "video" } } },
	}
	mock.method(console, "error", (message: string) => errors.push(message))
	const { screen_capture } = await load_module(
		"service/screen_capture.ts",
		imports,
	)
	return {
		service: screen_capture,
		recorders,
		notified,
		expire_deadline: () => {
			for (const [id, callback] of [...deadlines]) {
				deadlines.delete(id)
				callback()
			}
		},
		processes,
		copies,
		commands,
		notifications,
		errors,
		hold_query: () => {
			hold_pidof = true
		},
		release_query: () => resolve_pidof(""),
	}
}

test.afterEach(() => mock.restoreAll())

test("stopping recording while pidof is pending never starts slurp", async () => {
	const fixture = await service_fixture()
	fixture.hold_query()
	const started = fixture.service.start_recording({ scope: "area" })
	assert.equal(fixture.service.stop_recording().ok, true)
	fixture.release_query()
	assert.equal((await started).value, "cancelled")
	assert.equal(fixture.processes.length, 0)
})

test("shutdown while pidof is pending cancels screenshot before selection", async () => {
	const fixture = await service_fixture()
	fixture.hold_query()
	const screenshot = fixture.service.screenshot({ scope: "area" })
	await fixture.service.shutdown()
	fixture.release_query()
	assert.equal((await screenshot).value, "cancelled")
	assert.equal(fixture.processes.length, 0)
	assert.equal(
		fixture.commands.some((args) => args[0] === "grim"),
		false,
	)
})

test("shutdown after selector spawn cancels screenshot without grim", async () => {
	const fixture = await service_fixture()
	const screenshot = fixture.service.screenshot({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(fixture.processes.length, 1)
	await fixture.service.shutdown()
	assert.equal((await screenshot).value, "cancelled")
	assert.equal(
		fixture.commands.some((args) => args[0] === "grim"),
		false,
	)
})

test("shutdown after selector spawn cancels recording", async () => {
	const fixture = await service_fixture()
	const recording = fixture.service.start_recording({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(fixture.processes.length, 1)
	await fixture.service.shutdown()
	assert.equal((await recording).value, "cancelled")
})

test("stop after selector spawn cancels recording", async () => {
	const fixture = await service_fixture()
	const recording = fixture.service.start_recording({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(fixture.processes.length, 1)
	assert.equal(fixture.service.stop_recording().ok, true)
	assert.equal((await recording).value, "cancelled")
})

test("completed area selection captures via native finish callback", async () => {
	const fixture = await service_fixture()
	const screenshot = fixture.service.screenshot({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	fixture.processes[0].callback!(fixture.processes[0], {})
	assert.equal((await screenshot).value, "captured")
	assert.equal(
		fixture.commands.some(
			(args) => args[0] === "grim" && args[2] === "10,20 30x40",
		),
		true,
	)
})

test("focused screenshot after shutdown is cancelled without capturing", async () => {
	const fixture = await service_fixture()
	await fixture.service.shutdown()
	assert.equal((await fixture.service.screenshot()).value, "cancelled")
	assert.equal(
		fixture.commands.some((args) => args[0] === "grim"),
		false,
	)
})

test("screenshot copies the saved PNG to the clipboard and shows concise notification", async () => {
	const fixture = await service_fixture()
	assert.equal((await fixture.service.screenshot()).value, "captured")
	assert.deepEqual(fixture.copies, [
		{
			path: "/test/Pictures/Screenshots/time-uuid.png",
			mime_type: "image/png",
		},
	])
	assert.equal(fixture.notifications[0].body, "Saved to Pictures/Screenshots")
	assert.equal(
		fixture.notifications[0].preview_image,
		"/test/Pictures/Screenshots/time-uuid.png",
	)
})

test("failed clipboard provider exit is reported while the saved screenshot remains available", async () => {
	const fixture = await service_fixture({ copy_successful: false })
	assert.equal((await fixture.service.screenshot()).value, "captured")
	assert.deepEqual(fixture.errors, [
		"screen_capture.screenshot: Saved screenshot but failed to copy it",
	])
	assert.equal(fixture.notifications.length, 1)
})

test("failed grim capture returns its error without copying or notifying", async () => {
	const failure = new Error("grim exited 1")
	const fixture = await service_fixture({ capture_error: failure })
	const result = await fixture.service.screenshot()
	assert.equal(result.ok, false)
	assert.equal(result.err, failure)
	assert.deepEqual(fixture.errors, [
		"screen_capture.screenshot: Failed to take screenshot",
	])
	assert.equal(fixture.copies.length, 0)
	assert.equal(fixture.notifications.length, 0)
})

test("a selection exchange that cannot start returns its error and frees the selector", async () => {
	const failure = new Error("bad arguments")
	const fixture = await service_fixture({ start_error: failure })
	const result = await fixture.service.screenshot({ scope: "area" })
	assert.deepEqual(result, { ok: false, err: failure })
	assert.equal(
		fixture.commands.some((args) => args[0] === "grim"),
		false,
	)
	assert.equal(
		(await fixture.service.screenshot({ scope: "area" })).err,
		failure,
	)
	assert.equal(fixture.processes.length, 2)
})

test("an unsuccessful selector cancels without capturing", async () => {
	const fixture = await service_fixture({ selection_successful: false })
	const screenshot = fixture.service.screenshot({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	fixture.processes[0].callback!(fixture.processes[0], {})
	assert.equal((await screenshot).value, "cancelled")
	assert.equal(
		fixture.commands.some((args) => args[0] === "grim"),
		false,
	)
})

test("failed selection finish returns its error and frees the selector", async () => {
	const failure = new Error("slurp pipe broke")
	const fixture = await service_fixture({ finish_error: failure })
	const screenshot = fixture.service.screenshot({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	fixture.processes[0].callback!(fixture.processes[0], {})
	const result = await screenshot
	assert.equal(result.ok, false)
	assert.equal(result.err, failure)
	assert.equal(
		fixture.commands.some((args) => args[0] === "grim"),
		false,
	)
	const retry = fixture.service.screenshot({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(fixture.processes.length, 2)
	fixture.processes[1].callback!(fixture.processes[1], {})
	assert.equal((await retry).ok, false)
})

test("focused recording starts once, clears the starting flag and records the output", async () => {
	const fixture = await service_fixture()
	const started = await fixture.service.start_recording()
	assert.equal(started.value, "started")
	assert.equal(fixture.service.starting, false)
	assert.equal(fixture.service.recording, true)
	assert.deepEqual(fixture.notified.slice(0, 3), [
		"starting",
		"recording",
		"starting",
	])
	assert.deepEqual(fixture.recorders[0].args, [
		"wf-recorder",
		"-o",
		"DP-1",
		"-f",
		"/test/Videos/Screencasting/time-uuid.mkv",
		"--pixel-format",
		"yuv420p",
	])
	const again = await fixture.service.start_recording()
	assert.equal(again.ok, false)
	assert.equal(fixture.recorders.length, 1)
})

test("stopping interrupts the recorder once and a clean exit announces the file", async () => {
	const fixture = await service_fixture()
	await fixture.service.start_recording()
	const recorder = fixture.recorders[0]
	assert.equal(fixture.service.stop_recording().ok, true)
	assert.equal(fixture.service.stop_recording().ok, true)
	assert.deepEqual(recorder.signals, [2])
	recorder.exit(0, false)
	assert.equal(fixture.service.recording, false)
	await Promise.resolve()
	assert.equal(fixture.notifications.at(-1)?.summary, "Recording saved")
	assert.deepEqual(fixture.errors, [])
})

test("a failed recorder exit is logged instead of announced", async () => {
	const fixture = await service_fixture()
	await fixture.service.start_recording()
	fixture.service.stop_recording()
	fixture.recorders[0].exit(1, false)
	await Promise.resolve()
	assert.equal(fixture.notifications.length, 0)
	assert.deepEqual(fixture.errors, [
		"screen_capture.recorder: Exited with status 1; output unavailable",
	])
})

test("a stale recorder exit cannot end a newer recording", async () => {
	const fixture = await service_fixture()
	await fixture.service.start_recording()
	const first = fixture.recorders[0]
	first.exit(0, false)
	await fixture.service.start_recording()
	first.exit(0, false)
	assert.equal(fixture.service.recording, true)
	assert.equal(fixture.recorders.length, 2)
})

test("shutdown interrupts an active recorder and a clean exit resolves quietly", async () => {
	const fixture = await service_fixture()
	await fixture.service.start_recording()
	const recorder = fixture.recorders[0]
	const stopped = fixture.service.shutdown()
	assert.deepEqual(recorder.signals, [2])
	recorder.exit(0, false)
	assert.deepEqual(await stopped, { ok: true, value: undefined })
	assert.deepEqual(fixture.errors, [])
	assert.equal(fixture.notifications.length, 0)
})

test("shutdown reports a recorder that exits with a failure", async () => {
	const fixture = await service_fixture()
	await fixture.service.start_recording()
	const stopped = fixture.service.shutdown()
	fixture.recorders[0].exit(1, false)
	const result = await stopped
	assert.equal(result.ok, false)
	assert.match(String(result.err), /Recorder exited with status 1/)
})

test("shutdown kills a recorder that ignores the interrupt", async () => {
	const fixture = await service_fixture()
	await fixture.service.start_recording()
	const recorder = fixture.recorders[0]
	const stopped = fixture.service.shutdown()
	fixture.expire_deadline()
	const result = await stopped
	assert.equal(recorder.kills, 1)
	assert.equal(result.ok, false)
	assert.match(String(result.err), /did not exit after SIGINT/)
	recorder.exit(0, false)
	assert.equal(recorder.handlers.size, 1)
})

test("shutdown after a requested stop does not interrupt twice", async () => {
	const fixture = await service_fixture()
	await fixture.service.start_recording()
	const recorder = fixture.recorders[0]
	fixture.service.stop_recording()
	const stopped = fixture.service.shutdown()
	assert.deepEqual(recorder.signals, [2])
	recorder.exit(0, false)
	assert.equal((await stopped).ok, true)
})
