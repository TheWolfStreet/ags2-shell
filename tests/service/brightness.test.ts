import assert from "node:assert/strict"
import test, { mock } from "node:test"
import * as result from "../../lib/result.ts"
import { ok } from "../../lib/result.ts"
import { load_module } from "../load_module.ts"
import {
	tick,
	with_hyprland_command,
	immediate_debounce,
	flush_ticks,
	gobject_stub,
} from "../helpers.ts"

const logged: unknown[][] = []

test.beforeEach(() => {
	logged.length = 0
	mock.method(console, "error", (...args: unknown[]) => logged.push(args))
})

test.afterEach(() => mock.restoreAll())

async function settle() {
	await flush_ticks({ turns: 8 })
}

type run = (args: string[]) => Promise<result.result<string>> | undefined

async function fixture({
	backlight = true,
	keyboard = false,
	external = true,
	display_max = "100",
	display_read_error = null as Error | null,
	watch_error = null as Error | null,
	enumerate_error = null as Error | null,
	run = (() => undefined) as run,
	wait_for_init = true,
} = {}) {
	const commands: string[][] = []
	const watches = new Map()
	const notifications: { name: string; initialized: boolean }[] = []
	const timers: { kind: string; callback: () => void }[] = []
	const signals = new Map()
	const enumerated: string[] = []
	const reads: string[] = []
	const files = { display: "70", keyboard: "1", error: null as Error | null }
	function sysfs_names(path: string) {
		if (path.endsWith("backlight")) return backlight ? ["intel_backlight"] : []
		if (keyboard) return ["input0::kbd_backlight", "input0::capslock"]
		return ["input0::capslock"]
	}
	const imports = {
		"ags/gobject": gobject_stub((name, object) =>
			notifications.push({ name, initialized: object.initialized }),
		),
		"ags/file": {
			readFileAsync: (path) => {
				reads.push(path)
				const maximum = path.endsWith("max_brightness")
				if (files.error && !maximum) return Promise.reject(files.error)
				if (path.includes("/leds/"))
					return Promise.resolve(maximum ? "3" : files.keyboard)
				if (display_read_error) return Promise.reject(display_read_error)
				return Promise.resolve(maximum ? display_max : files.display)
			},
			monitorFile: (path, callback) => {
				if (watch_error) throw watch_error
				watches.set(path, callback)
				return { cancel() {} }
			},
		},
		"$lib/time": {
			idle: (callback) => {
				timers.push({ kind: "idle", callback })
				return { cancel() {} }
			},
			timeout: (_delay, callback) => {
				timers.push({ kind: "timeout", callback })
				return { cancel() {} }
			},
			debounce: immediate_debounce,
		},
		"gi://Gio": {
			default: {
				FileQueryInfoFlags: { NONE: 0 },
				File: {
					new_for_path: (path) => ({
						enumerate_children: () => {
							enumerated.push(path)
							if (enumerate_error) throw enumerate_error
							const names = sysfs_names(path)
							return {
								next_file: () => {
									const name = names.shift()
									return name ? { get_name: () => name } : null
								},
								close() {},
							}
						},
					}),
				},
			},
		},
		"gi://GLib": {
			default: {
				find_program_in_path: (name) =>
					name === "ddcutil" && external ? name : null,
			},
		},
		"$lib/hyprland": with_hyprland_command({
			hyprland: {
				connect: (name, callback) => {
					signals.set(name, callback)
					return signals.size
				},
				disconnect() {},
			},
		}),
		"$lib/commands": {
			run_command: async (args) => {
				commands.push(args)
				const custom = run(args)
				if (custom) return custom
				if (args[1] === "detect")
					return ok(
						"Display 1\nDRM connector: DP-1\n\nDisplay 2\nDRM connector: HDMI-A-1",
					)
				if (args[1] === "getvcp")
					return ok(args.at(-1) === "1" ? "VCP 10 C 30 100" : "VCP 10 C 70 100")
				return ok("")
			},
		},
	}
	const namespace = await load_module("service/brightness.ts", imports)
	if (wait_for_init) await tick()
	return {
		service: namespace.brightness,
		namespace,
		commands,
		watches,
		notifications,
		timers,
		signals,
		enumerated,
		reads,
		files,
		set_keyboard_raw: (value) => {
			files.keyboard = value
		},
		discover: async () => {
			timers.find((timer) => timer.kind === "idle")!.callback()
			await settle()
		},
	}
}

test("external discovery reads unequal brightness without writing; explicit slider writes both endpoints", async () => {
	const state = await fixture()
	assert.equal(
		state.service.displayAvailable,
		true,
		JSON.stringify([logged, state.enumerated, state.reads]),
	)
	assert.equal(state.service.display, 0.7, JSON.stringify(logged))
	await state.discover()
	assert.equal(state.service.display, 0.7)
	assert.deepEqual(
		state.commands.filter((args) => args[1] === "setvcp"),
		[],
	)
	assert.deepEqual(
		state.commands.filter((args) => args[0] === "brightnessctl"),
		[],
	)
	const result = await state.service.set_display(0.5)
	assert.equal(result.value, "applied")
	assert.deepEqual(
		state.commands
			.filter((args) => args[1] === "setvcp")
			.map((args) => args.at(-2)),
		["1", "2"],
	)
	assert.deepEqual(
		state.commands.filter((args) => args[0] === "brightnessctl"),
		[["brightnessctl", "-d", "intel_backlight", "set", "50%", "-q"]],
	)
	state.signals.get("monitor-added")()
	await settle()
	assert.equal(state.commands.filter((args) => args[1] === "setvcp").length, 2)
})

test("external-only startup and hotplug observe distinct values without synchronizing them", async () => {
	const state = await fixture({ backlight: false })
	await state.discover()
	assert.equal(state.service.initialized, true)
	assert.equal(state.service.display, 0.3)
	state.signals.get("monitor-added")()
	await settle()
	assert.equal(state.commands.filter((args) => args[1] === "setvcp").length, 0)
	const applied = await state.service.set_display(0.6)
	assert.equal(applied.value, "applied")
	assert.deepEqual(
		state.commands
			.filter((args) => args[1] === "setvcp")
			.map((args) => args[3]),
		["60", "60"],
	)
})

test("keyboard-only device initializes without startup OSD and later keyboard changes notify", async () => {
	const state = await fixture({
		backlight: false,
		keyboard: true,
		external: false,
	})
	assert.equal(
		state.service.initialized,
		true,
		JSON.stringify([logged, state.enumerated, state.reads]),
	)
	assert.equal(state.service.displayAvailable, false)
	assert.equal(state.service.kbd, 1 / 3)
	assert.deepEqual(
		state.notifications
			.filter((event) => event.name === "kbd")
			.map((event) => event.initialized),
		[false],
	)
	const path = "/sys/class/leds/input0::kbd_backlight/brightness"
	state.set_keyboard_raw("2")
	state.watches.get(path)(path)
	await tick()
	assert.equal(state.service.kbd, 2 / 3)
	assert.deepEqual(
		state.notifications
			.filter((event) => event.name === "kbd")
			.map((event) => event.initialized),
		[false, true],
	)
	assert.equal(state.commands.length, 0)
})

test("brief DDC output parses current and maximum", async () => {
	const { parse_ddc_brightness } = (await fixture()).namespace
	assert.deepEqual(parse_ddc_brightness("VCP 10 C 50 100"), {
		current: 50,
		maximum: 100,
	})
	assert.deepEqual(parse_ddc_brightness("VCP 10 C 127 255"), {
		current: 127,
		maximum: 255,
	})
	assert.equal(parse_ddc_brightness("VCP 10 ERR"), null)
	assert.equal(parse_ddc_brightness("VCP 10 C 300 255"), null)
	assert.equal(parse_ddc_brightness("VCP 10 C 0 0"), null)
	assert.equal(
		parse_ddc_brightness("VCP 10 C 99999999999999999999 99999999999999999999"),
		null,
	)
})

test("percent writes use each display maximum and clamp invalid input", async () => {
	const { brightness_target } = (await fixture()).namespace
	assert.equal(brightness_target(0.5, 255), 128)
	assert.equal(brightness_target(0.5, 100), 50)
	assert.equal(brightness_target(1.3, 255), 255)
	assert.equal(brightness_target(Number.NaN, 255), 0)
	assert.equal(brightness_target(0.6), 60)
	assert.equal(brightness_target(0.5), 50)
})

test("invalid sysfs maximum disables the display with the reason", async () => {
	const state = await fixture({ external: false, display_max: "0" })
	assert.equal(state.service.displayAvailable, false)
	const reported = logged.find(
		([tag]) => tag === "brightness.init: Failed to read display brightness",
	)
	assert.ok(reported, JSON.stringify(logged))
	assert.equal(
		(reported[1] as Error).message,
		"Invalid brightness from /sys/class/backlight/intel_backlight",
	)
})

test("failed sysfs read disables the display with the read error", async () => {
	const failure = new Error("permission denied")
	const state = await fixture({ external: false, display_read_error: failure })
	assert.equal(state.service.displayAvailable, false)
	const reported = logged.find(
		([tag]) => tag === "brightness.init: Failed to read display brightness",
	)
	assert.ok(reported, JSON.stringify(logged))
	assert.equal(reported[1], failure)
})

const display_path = "/sys/class/backlight/intel_backlight/brightness"
const keyboard_path = "/sys/class/leds/input0::kbd_backlight/brightness"

function display_events(state) {
	return state.notifications.filter((event) => event.name === "display").length
}

test("external sysfs changes update the display only while no write is pending", async () => {
	const state = await fixture({ external: false })
	const before = display_events(state)
	state.files.display = "40"
	state.watches.get(display_path)(display_path)
	await settle()
	assert.equal(state.service.display, 0.4)
	assert.equal(display_events(state), before + 1)
	state.watches.get(display_path)(display_path)
	await settle()
	assert.equal(display_events(state), before + 1)
	assert.equal((await state.service.set_display(0.4)).value, "applied")
	assert.deepEqual(
		state.commands.filter((args) => args[0] === "brightnessctl"),
		[],
	)
})

test("failed device reads and watches are logged with their device", async () => {
	const state = await fixture({ keyboard: true, external: false })
	const failure = new Error("gone")
	state.files.error = failure
	state.watches.get(display_path)(display_path)
	state.watches.get(keyboard_path)(keyboard_path)
	await settle()
	assert.deepEqual(logged, [
		["brightness.monitor: Failed to read display brightness", failure],
		["brightness.monitor: Failed to read keyboard brightness", failure],
	])
	logged.length = 0
	const refused = new Error("inotify")
	await fixture({ keyboard: true, external: false, watch_error: refused })
	assert.deepEqual(logged, [
		["brightness.monitor: Failed to watch display", refused],
		["brightness.monitor: Failed to watch keyboard", refused],
	])
})

test("keyboard changes ignore unreadable values", async () => {
	const state = await fixture({
		backlight: false,
		keyboard: true,
		external: false,
	})
	const before = state.notifications.length
	state.set_keyboard_raw("nan")
	state.watches.get(keyboard_path)(keyboard_path)
	await settle()
	state.set_keyboard_raw("1")
	state.watches.get(keyboard_path)(keyboard_path)
	await settle()
	assert.equal(state.notifications.length, before)
	assert.equal(state.service.kbd, 1 / 3)
})

test("detection skips internal panels and duplicate displays", async () => {
	const state = await fixture({
		backlight: false,
		run: (args) => {
			if (args[1] !== "detect") return undefined
			return Promise.resolve(
				ok(
					"Display 1\nDRM connector: card1-eDP-1\n\nDisplay 2\nDRM connector: card1-LVDS-1\n\n  Display 3\n   DRM connector: card1-DP-2\n\n\nInvalid display\nDRM connector: DP-3\n\nDisplay 4\nDRM connector: card1-DP-3\n\nDisplay 4\nDRM connector: card1-DP-3",
				),
			)
		},
	})
	await state.discover()
	assert.deepEqual(
		state.commands
			.filter((args) => args[1] === "getvcp")
			.map((args) => args.at(-1)),
		["3", "4"],
	)
	assert.equal(state.service.display, 0.7)
	assert.equal(state.service.displayAvailable, true)
})

test("a failed detection is logged and retried later", async () => {
	const failure = new Error("i2c busy")
	let fail = true
	const state = await fixture({
		backlight: false,
		run: (args) => {
			if (args[1] === "detect" && fail)
				return Promise.resolve(result.err(failure))
			return undefined
		},
	})
	await state.discover()
	assert.deepEqual(logged, [
		["brightness.ddc.detect: Failed to detect external displays", failure],
	])
	assert.equal(state.service.displayAvailable, false)
	const retry = state.timers.filter((timer) => timer.kind === "timeout")
	assert.equal(retry.length, 1)
	fail = false
	retry[0].callback()
	await settle()
	assert.equal(state.service.displayAvailable, true)
	assert.equal(state.service.display, 0.3)
})

test("an unreadable display keeps its previous state and schedules a retry", async () => {
	const failure = new Error("no reply")
	let fail = false
	const state = await fixture({
		backlight: false,
		run: (args) => {
			if (args[1] === "getvcp" && args.at(-1) === "2" && fail)
				return Promise.resolve(result.err(failure))
			return undefined
		},
	})
	await state.discover()
	assert.equal(
		state.timers.filter((timer) => timer.kind === "timeout").length,
		0,
	)
	await state.service.set_display(0.5)
	fail = true
	state.signals.get("monitor-added")()
	await settle()
	assert.deepEqual(logged, [
		["brightness.ddc.read: Failed to read display 2", failure],
	])
	assert.equal(
		state.timers.filter((timer) => timer.kind === "timeout").length,
		1,
	)
	state.commands.length = 0
	await state.service.set_display(0.5)
	assert.deepEqual(
		state.commands
			.filter((args) => args[1] === "setvcp")
			.map((args) => args.at(-2)),
		["1"],
	)
	state.commands.length = 0
	await state.service.set_display(0.6)
	assert.deepEqual(
		state.commands
			.filter((args) => args[1] === "setvcp")
			.map((args) => args.at(-2)),
		["1", "2"],
	)
})

test("a rescan of already available displays keeps the slider value", async () => {
	let first_reading = "VCP 10 C 30 100"
	const state = await fixture({
		backlight: false,
		run: (args) => {
			if (args[1] === "getvcp" && args.at(-1) === "1")
				return Promise.resolve(ok(first_reading))
			return undefined
		},
	})
	await state.discover()
	assert.equal(state.service.display, 0.3)
	first_reading = "VCP 10 C 80 100"
	state.signals.get("monitor-added")()
	await settle()
	assert.equal(state.service.display, 0.3)
})

test("a failed write reports every failing device and shows the applied level", async () => {
	const failure = new Error("brightnessctl failed")
	const ddc_failure = new Error("setvcp failed")
	const state = await fixture({
		run: (args) => {
			if (args[0] === "brightnessctl")
				return Promise.resolve(result.err(failure))
			if (args[1] === "setvcp" && args.at(-2) === "2")
				return Promise.resolve(result.err(ddc_failure))
			return undefined
		},
	})
	await state.discover()
	const before = display_events(state)
	const written = await state.service.set_display(0.5)
	assert.equal(written.ok, false)
	assert.equal(written.err.message, "Brightness 50% failed on 2 device(s)")
	assert.deepEqual(written.err.cause, [failure, ddc_failure])
	assert.deepEqual(logged, [
		["brightness.write: Failed to set internal display brightness", failure],
		["brightness.ddc.write: Failed to set display 2 to 50%", ddc_failure],
	])
	assert.equal(state.service.display, 0.7)
	assert.equal(display_events(state), before + 2)
})

test("a newer slider value supersedes a queued one and finalize stops pending writes", async () => {
	const releases: (() => void)[] = []
	let hold = true
	const state = await fixture({
		external: false,
		run: (args) => {
			if (args[0] !== "brightnessctl" || !hold) return undefined
			return new Promise((resolve) => releases.push(() => resolve(ok(""))))
		},
	})
	const first = state.service.set_display(0.2)
	const second = state.service.set_display(0.3)
	let third_done = false
	const third = state.service.set_display(0.4).then((outcome) => {
		third_done = true
		return outcome
	})
	assert.equal((await first).value, "superseded")
	assert.equal((await second).value, "superseded")
	releases[0]()
	await settle()
	assert.equal(third_done, false)
	releases[1]()
	assert.equal((await third).value, "applied")
	assert.deepEqual(
		state.commands
			.filter((args) => args[0] === "brightnessctl")
			.map((args) => args[4]),
		["20%", "40%"],
	)
	hold = false
	const stopped = state.service.set_display(0.9)
	state.service.vfunc_finalize()
	const outcome = await stopped
	assert.equal(outcome.ok, false)
	assert.equal(outcome.err.message, "Brightness service stopped")
})

test("sysfs changes during a write leave the slider value alone", async () => {
	let release
	const state = await fixture({
		external: false,
		run: (args) => {
			if (args[0] !== "brightnessctl") return undefined
			return new Promise((resolve) => {
				release = () => resolve(ok(""))
			})
		},
	})
	const written = state.service.set_display(0.5)
	state.files.display = "20"
	state.watches.get(display_path)(display_path)
	await settle()
	assert.equal(state.service.display, 0.5)
	release()
	assert.equal((await written).value, "applied")
})

test("writes wait for initialization and unknown leds are not keyboards", async () => {
	const state = await fixture({ external: false, wait_for_init: false })
	const early = await state.service.set_display(0.5)
	assert.equal(early.ok, false)
	assert.equal(
		early.err.message,
		"No initialized brightness device is available",
	)
	await settle()
	assert.equal((await state.service.set_display(0.5)).value, "applied")
	assert.equal(
		state.reads.some((path) => path.includes("capslock")),
		false,
	)
})

test("an unreadable sysfs class is logged and treated as absent", async () => {
	const failure = new Error("no sysfs")
	const state = await fixture({ external: false, enumerate_error: failure })
	assert.deepEqual(logged, [
		["brightness.devices: Failed to enumerate /sys/class/backlight", failure],
		["brightness.devices: Failed to enumerate /sys/class/leds", failure],
	])
	assert.equal(state.service.displayAvailable, false)
	assert.equal(state.service.initialized, false)
})

test("malformed DDC readings are reported per display", async () => {
	const state = await fixture({
		backlight: false,
		run: (args) => {
			if (args[1] === "getvcp" && args.at(-1) === "2")
				return Promise.resolve(ok("VCP 10 ERR"))
			return undefined
		},
	})
	await state.discover()
	assert.equal(logged.length, 1)
	assert.equal(logged[0][0], "brightness.ddc.read: Failed to read display 2")
	assert.equal(
		(logged[0][1] as Error).message,
		"Invalid DDC brightness for display 2: VCP 10 ERR",
	)
	assert.equal(state.service.display, 0.3)
})

test("hotplug while reading restarts detection before reading further displays", async () => {
	let release: (() => void) | null | undefined = null
	const state = await fixture({
		backlight: false,
		run: (args) => {
			if (args[1] !== "getvcp" || args.at(-1) !== "1" || release !== undefined)
				return undefined
			return new Promise((resolve) => {
				release = () => resolve(ok("VCP 10 C 30 100"))
			})
		},
	})
	release = undefined
	state.timers.find((timer) => timer.kind === "idle")!.callback()
	await settle()
	state.signals.get("monitor-added")()
	const pending = release as unknown as () => void
	release = null
	pending()
	await settle()
	assert.deepEqual(
		state.commands.map((args) => [args[1], args.at(-1)]),
		[
			["detect", "detect"],
			["getvcp", "1"],
			["detect", "detect"],
			["getvcp", "1"],
			["getvcp", "2"],
		],
	)
})

test("a successful rescan clears the retry so a later failure retries again", async () => {
	const failure = new Error("no reply")
	let fail = true
	const state = await fixture({
		backlight: false,
		run: (args) => {
			if (args[1] === "getvcp" && args.at(-1) === "2" && fail)
				return Promise.resolve(result.err(failure))
			return undefined
		},
	})
	const retries = () =>
		state.timers.filter((timer) => timer.kind === "timeout").length
	await state.discover()
	assert.equal(retries(), 1)
	fail = false
	state.signals.get("monitor-added")()
	await settle()
	assert.equal(retries(), 1)
	fail = true
	state.signals.get("monitor-added")()
	await settle()
	assert.equal(retries(), 2)
})

test("hotplug during a write refreshes after the write completes", async () => {
	let release
	const state = await fixture({
		run: (args) => {
			if (args[0] !== "brightnessctl") return undefined
			return new Promise((resolve) => {
				release = () => resolve(ok(""))
			})
		},
	})
	await state.discover()
	const written = state.service.set_display(0.5)
	await tick()
	const detections = () =>
		state.commands.filter((args) => args[1] === "detect").length
	assert.equal(detections(), 1)
	state.signals.get("monitor-added")()
	await settle()
	assert.equal(detections(), 1)
	release()
	assert.equal((await written).value, "applied")
	await settle()
	assert.equal(detections(), 2)
})

test("writes are refused until a device is initialized", async () => {
	const state = await fixture({ backlight: false, external: false })
	const refused = await state.service.set_display(0.5)
	assert.equal(refused.ok, false)
	assert.equal(
		refused.err.message,
		"No initialized brightness device is available",
	)
	assert.equal(state.service.initialized, false)
})
