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

test("opening Quick Settings observes profile without applying panel policy; manual profile does", async () => {
	const commands = []
	const messages = []
	const handlers = new Map()
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
	let profile = "Balanced"
	const panel = {
		name: "eDP-1",
		disabled: false,
		width: 1920,
		height: 1080,
		x: 0,
		y: 0,
		scale: 1,
		transform: 0,
		refreshRate: 60,
		availableModes: ["1920x1080@60", "1920x1080@120"],
	}
	const option = (value) => ({
		peek: () => value,
		set: (next) => {
			value = next
		},
		subscribe: () => () => {},
	})
	const imports = {
		"ags/gobject": {
			default: {
				Object: class {
					notify() {}
					vfunc_finalize() {}
				},
			},
			getter: () => () => {},
			register: () => (value) => value,
		},
		"$lib/hyprland": {
			hyprland: {
				connect: (name, callback) => {
					handlers.set(name, callback)
					return handlers.size
				},
				disconnect() {},
				message_async: async (command) => {
					messages.push(command)
					return "ok"
				},
			},
		},
		"gi://GLib": {
			default: {
				find_program_in_path: (name) => (name === "asusctl" ? name : null),
			},
		},
		"$lib/result": { ok, err, attempt, attempt_async },
		"$shell/options": {
			default: { asus: { ac_hz: option(120), bat_hz: option(60) } },
		},
		"./monitorConfiguration": {
			format_monitor_command: (monitor, change) =>
				`keyword monitor ${monitor.name},${monitor.width}x${monitor.height}@${change.refresh_rate},${monitor.x}x${monitor.y},${monitor.scale}`,
		},
		"./commands": {
			run_command: async (args) => {
				commands.push(args)
				if (args[0] === "hyprctl") return ok(JSON.stringify([panel]))
				if (args[2] === "set") {
					profile = args[3]
					return ok("")
				}
				return ok(`Active profile: ${profile}`)
			},
		},
	}
	const source = readFileSync(
		new URL("../../service/asusctl.ts", import.meta.url),
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
	const service = module.namespace.asusctl
	await tick()
	assert.deepEqual(messages, ["keyword monitor eDP-1,1920x1080@120,0x0,1"])
	messages.length = 0
	commands.length = 0
	profile = "Quiet"
	let on_toggle
	const noop = () => {}
	const widget_imports = {
		"$lib/app": { default: { connect: noop } },
		"ags/gtk4": { Gtk: { Orientation: { VERTICAL: 1 }, Separator: noop } },
		"ags/gtk4/jsx-runtime": {
			jsx: (type, props) => ({ type, props }),
			jsxs: (type, props) => ({ type, props }),
		},
		ags: {
			With: noop,
			createBinding: (object, key) => () => object[key],
			createComputed: (fn) => fn,
			createState: (value) => [() => value, noop],
			onCleanup: noop,
		},
		"gi://AstalPowerProfiles": { default: {} },
		"gi://Gio": {
			default: {
				BusType: { SYSTEM: 0 },
				BusNameWatcherFlags: { NONE: 0 },
				bus_watch_name: () => 1,
				bus_unwatch_name: noop,
			},
		},
		"gi://GLib": imports["gi://GLib"],
		"widget/Bar/components/QuickSettings/components/MenuControls": {
			ToggleButton: noop,
			Menu: noop,
			SettingsButton: noop,
		},
		"widget/shared/Placeholder": { Placeholder: noop },
		"$lib/icons": { default: {} },
		"$lib/result": { attempt },
		"$lib/apps": { launch_program: noop },
		"$lib/notifications": { notify_missing_programs: noop },
		"$service/asusctl": { asusctl: service },
		"$lib/windowing": {
			on_window_toggle: (_name, callback) => {
				on_toggle = callback
				return noop
			},
		},
	}
	const widget_source = readFileSync(
		new URL(
			"../../widget/Bar/components/QuickSettings/components/PowerProfiles.tsx",
			import.meta.url,
		),
		"utf8",
	)
	const widget_compiled = ts.transpileModule(widget_source, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
			jsxImportSource: "ags/gtk4",
		},
	}).outputText
	const widget = new SourceTextModule(widget_compiled)
	await widget.link((name) => {
		assert.ok(widget_imports[name], name)
		return new SyntheticModule(Object.keys(widget_imports[name]), function () {
			for (const [key, value] of Object.entries(widget_imports[name]))
				this.setExport(key, value)
		})
	})
	await widget.evaluate()
	widget.namespace.PowerProfiles.Selector()
	on_toggle({ visible: true })
	await tick()
	assert.equal(service.profile, "Quiet")
	assert.deepEqual(commands, [["asusctl", "profile", "get"]])
	assert.deepEqual(messages, [])
	for (const signal of [
		"monitor-added",
		"monitor-removed",
		"config-reloaded",
	]) {
		handlers.get(signal)()
		await tick()
		assert.deepEqual(messages, [], signal)
	}
	panel.availableModes = ["1920x1080@60", "1920x1080@144"]
	handlers.get("monitor-added")()
	await tick()
	assert.deepEqual(service.refreshRates, [60, 144])
	assert.equal(imports["$shell/options"].default.asus.ac_hz.peek(), 120)
	assert.deepEqual(messages, [])
	panel.availableModes = ["1920x1080@60", "1920x1080@120"]
	assert.equal((await service.set_profile("Performance")).ok, true)
	assert.deepEqual(messages, ["keyword monitor eDP-1,1920x1080@120,0x0,1"])
})

for (const order of ["observer first", "manual first", "observer removed"]) {
	test(`deferred ${order} monitor query preserves explicit policy and newest metadata`, async () => {
		const requests = []
		const messages = []
		const notifications = []
		const handlers = new Map()
		const option_changes = []
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
		const panel = {
			name: "eDP-1",
			disabled: false,
			width: 1920,
			height: 1080,
			x: 0,
			y: 0,
			scale: 1,
			transform: 0,
			refreshRate: 60,
			availableModes: ["1920x1080@60", "1920x1080@120"],
		}
		const option = (value) => ({
			peek: () => value,
			set: (next) => {
				value = next
			},
			subscribe: (callback) => {
				option_changes.push(callback)
				return () => {}
			},
		})
		let deferred = false
		const imports = {
			"ags/gobject": {
				default: {
					Object: class {
						notify(name) {
							notifications.push(name)
						}
						vfunc_finalize() {}
					},
				},
				getter: () => () => {},
				register: () => (value) => value,
			},
			"$lib/hyprland": {
				hyprland: {
					connect: (name, callback) => {
						handlers.set(name, callback)
						return handlers.size
					},
					disconnect() {},
					message_async: async (command) => {
						messages.push(command)
						return "ok"
					},
				},
			},
			"gi://GLib": {
				default: {
					find_program_in_path: (name) => (name === "asusctl" ? name : null),
				},
			},
			"$lib/result": { ok, err, attempt, attempt_async },
			"$shell/options": {
				default: { asus: { ac_hz: option(120), bat_hz: option(60) } },
			},
			"./monitorConfiguration": {
				format_monitor_command: (monitor, change) =>
					`keyword monitor ${monitor.name},${monitor.width}x${monitor.height}@${change.refresh_rate},${monitor.x}x${monitor.y},${monitor.scale}`,
			},
			"./commands": {
				run_command: async (args) => {
					if (args[0] === "asusctl")
						return ok(args[2] === "set" ? "" : "Active profile: Balanced")
					if (!deferred) return ok(JSON.stringify([panel]))
					return new Promise((resolve) => requests.push(resolve))
				},
			},
		}
		const source = readFileSync(
			new URL("../../service/asusctl.ts", import.meta.url),
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
		await module.link(
			(name) =>
				new SyntheticModule(Object.keys(imports[name]), function () {
					for (const [key, value] of Object.entries(imports[name]))
						this.setExport(key, value)
				}),
		)
		await module.evaluate()
		const service = module.namespace.asusctl
		await tick()
		messages.length = 0
		notifications.length = 0
		deferred = true
		const manual = service.set_profile("Performance")
		await tick()
		handlers.get("monitor-added")()
		assert.equal(requests.length, 2)
		const manual_panel = {
			...panel,
			availableModes: ["1920x1080@60", "1920x1080@120"],
		}
		const observed_panel = {
			...panel,
			availableModes: ["1920x1080@60", "1920x1080@144"],
		}
		if (order !== "manual first") {
			requests[1](
				ok(
					JSON.stringify(order === "observer removed" ? [] : [observed_panel]),
				),
			)
			await tick()
			requests[0](ok(JSON.stringify([manual_panel])))
		} else {
			requests[0](ok(JSON.stringify([manual_panel])))
			await tick()
			requests[1](ok(JSON.stringify([observed_panel])))
		}
		await manual
		await tick()
		assert.deepEqual(
			service.refreshRates,
			order === "observer removed" ? [] : [60, 144],
		)
		assert.equal(
			notifications.filter((name) => name === "refresh-rates").length,
			1,
		)
		assert.deepEqual(
			messages,
			order === "observer removed"
				? []
				: [
						order === "observer first"
							? "keyword monitor eDP-1,1920x1080@144,0x0,1"
							: "keyword monitor eDP-1,1920x1080@120,0x0,1",
					],
		)
		if (order === "manual first") {
			messages.length = 0
			const ac_hz = imports["$shell/options"].default.asus.ac_hz
			ac_hz.set(60)
			option_changes[0]()
			ac_hz.set(120)
			option_changes[0]()
			assert.equal(requests.length, 4)
			requests[3](ok(JSON.stringify([panel])))
			await tick()
			requests[2](ok(JSON.stringify([panel])))
			await tick()
			assert.deepEqual(messages, ["keyword monitor eDP-1,1920x1080@120,0x0,1"])
		}
	})
}
