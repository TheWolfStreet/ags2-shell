import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(
	execFileSync("which", ["tsc"], { encoding: "utf8" }).trim(),
)
const ts = createRequire(tsc_path)(
	"../lib/node_modules/typescript/lib/typescript.js",
)
const tick = () => new Promise((resolve) => setImmediate(resolve))

async function fixture({
	backlight = true,
	keyboard = false,
	external = true,
} = {}) {
	const commands = []
	const watches = new Map()
	const notifications = []
	const errors = []
	const timers = []
	const signals = new Map()
	const enumerated = []
	const reads = []
	let keyboard_raw = "1"
	const ok = (value) => ({ ok: true, value })
	const err = (err) => ({ ok: false, err })
	const attempt = (fn) => {
		try {
			return ok(fn())
		} catch (error) {
			return err(error)
		}
	}
	const attempt_async = async (fn) => {
		try {
			return ok(await fn())
		} catch (error) {
			return err(error)
		}
	}
	const imports = {
		"ags/gobject": {
			default: {
				Object: class {
					notify(name) {
						notifications.push({ name, initialized: this.initialized })
					}
					vfunc_finalize() {}
				},
			},
			getter: () => () => {},
			register: () => (value) => value,
		},
		"ags/file": {
			readFileAsync: (path) => {
				reads.push(path)
				return Promise.resolve(
					path.includes("/leds/")
						? path.endsWith("max_brightness")
							? "3"
							: keyboard_raw
						: path.endsWith("max_brightness")
							? "100"
							: "70",
				)
			},
			monitorFile: (path, callback) => {
				watches.set(path, callback)
				return { cancel() {} }
			},
		},
		"ags/process": {
			execAsync: (args) => {
				commands.push(args)
				return Promise.resolve("")
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
			debounce: (_delay, callback) => ({ call: callback, cancel() {} }),
		},
		"gi://Gio": {
			default: {
				FileQueryInfoFlags: { NONE: 0 },
				File: {
					new_for_path: (path) => ({
						enumerate_children: () => {
							enumerated.push(path)
							const names = path.endsWith("backlight")
								? backlight
									? ["intel_backlight"]
									: []
								: keyboard
									? ["input0::kbd_backlight"]
									: []
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
		"$lib/result": {
			ok,
			err,
			attempt,
			attempt_async,
			log_error: (result, message) => {
				if (!result.ok) errors.push([message, result.err])
				return result.ok
			},
		},
		"$lib/hyprland": {
			hyprland: {
				connect: (name, callback) => {
					signals.set(name, callback)
					return signals.size
				},
				disconnect() {},
			},
		},
		"./brightnessMath": {
			brightness_target: (percent, maximum = 100) =>
				Math.round(percent * maximum),
			parse_ddc_brightness: (raw) => {
				const match = raw.match(/C (\d+) (\d+)/)
				return match
					? { current: Number(match[1]), maximum: Number(match[2]) }
					: null
			},
		},
		"./commands": {
			run_command: async (args) => {
				commands.push(args)
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
	const source = readFileSync(
		new URL("../../service/brightness.ts", import.meta.url),
		"utf8",
	)
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			experimentalDecorators: true,
		},
	}).outputText
	const module = new SourceTextModule(compiled)
	await module.link((name) => {
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name]))
				this.setExport(key, value)
		})
	})
	await module.evaluate()
	await tick()
	return {
		service: module.namespace.brightness,
		commands,
		watches,
		notifications,
		timers,
		signals,
		errors,
		enumerated,
		reads,
		set_keyboard_raw: (value) => {
			keyboard_raw = value
		},
		discover: async () => {
			timers.find((timer) => timer.kind === "idle").callback()
			for (let i = 0; i < 8; i++) await tick()
		},
	}
}

test("external discovery reads unequal brightness without writing; explicit slider writes both endpoints", async () => {
	const state = await fixture()
	assert.equal(
		state.service.displayAvailable,
		true,
		JSON.stringify([state.errors, state.enumerated, state.reads]),
	)
	assert.equal(state.service.display, 0.7, JSON.stringify(state.errors))
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
	for (let i = 0; i < 8; i++) await tick()
	assert.equal(state.commands.filter((args) => args[1] === "setvcp").length, 2)
})

test("external-only startup and hotplug observe distinct values without synchronizing them", async () => {
	const state = await fixture({ backlight: false })
	await state.discover()
	assert.equal(state.service.initialized, true)
	assert.equal(state.service.display, 0.3)
	state.signals.get("monitor-added")()
	for (let i = 0; i < 8; i++) await tick()
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
		JSON.stringify([state.errors, state.enumerated, state.reads]),
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
