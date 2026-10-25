import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { with_hyprland_command } from "../hyprland.ts"
import * as result from "../../lib/result.ts"
import { err, ok } from "../../lib/result.ts"
import * as lua from "../../lib/lua.ts"
import { jsx_runtime, tick } from "../helpers.ts"

const monitor_configuration = await load_module(
	"service/monitor_configuration.ts",
	{ "$lib/lua": lua },
)

function rule(mode: string) {
	return `eval hl.monitor({ output = "eDP-1", mode = "${mode}", position = "0x0", scale = 1, transform = 0, mirror = "none" })`
}

function edp_panel() {
	return {
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
}

type run = (args: string[]) => Promise<result.result<string>>

async function fixture({
	run,
	programs = ["asusctl"],
	reply = "ok",
}: {
	run: run
	programs?: string[]
	reply?: string
}) {
	const messages: string[] = []
	const notifications: string[] = []
	const handlers = new Map()
	const option_changes: (() => void)[] = []
	function option(value: number) {
		return {
			peek: () => value,
			set: (next: number) => {
				value = next
			},
			subscribe: (callback: () => void) => {
				option_changes.push(callback)
				return () => {}
			},
		}
	}
	const asus = { ac_hz: option(120), bat_hz: option(60) }
	const imports = {
		"ags/gobject": {
			default: {
				Object: class {
					notify(name: string) {
						notifications.push(name)
					}
					vfunc_finalize() {}
				},
			},
			getter: () => () => {},
			register: () => (value) => value,
		},
		"$lib/hyprland": with_hyprland_command({
			hyprland: {
				connect: (name, callback) => {
					handlers.set(name, callback)
					return handlers.size
				},
				disconnect() {},
				message_async: async (command) => {
					messages.push(command)
					return reply
				},
			},
		}),
		"gi://GLib": {
			default: {
				find_program_in_path: (name: string) =>
					programs.includes(name) ? name : null,
			},
		},
		"$shell/options": { default: { asus } },
		"./monitor_configuration": monitor_configuration,
		"$lib/commands": { run_command: run },
	}
	const { asusctl: service } = await load_module("service/asusctl.ts", imports)
	await tick()
	return {
		service,
		imports,
		messages,
		notifications,
		handlers,
		option_changes,
		asus,
	}
}

function profile_reader(
	profile = "Balanced",
	monitors: () => unknown = () => [edp_panel()],
): run {
	return async (args) => {
		if (args[0] === "hyprctl") return ok(JSON.stringify(monitors()))
		if (args[2] === "set") return ok("")
		return ok(`Active profile: ${profile}`)
	}
}

test("opening Quick Settings observes profile without applying panel policy; manual profile does", async () => {
	const commands: string[][] = []
	let profile = "Balanced"
	const panel = edp_panel()
	const { service, imports, messages, handlers, asus } = await fixture({
		run: async (args) => {
			commands.push(args)
			if (args[0] === "hyprctl") return ok(JSON.stringify([panel]))
			if (args[2] === "set") {
				profile = args[3]
				return ok("")
			}
			return ok(`Active profile: ${profile}`)
		},
	})
	assert.deepEqual(messages, [rule("1920x1080@120")])
	messages.length = 0
	commands.length = 0
	profile = "Quiet"
	let on_toggle
	const noop = () => {}
	const widget_imports = {
		"$lib/app": { default: { connect: noop } },
		"ags/gtk4": { Gtk: { Orientation: { VERTICAL: 1 }, Separator: noop } },
		"ags/gtk4/jsx-runtime": jsx_runtime,
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
		"$lib/apps": { launch_program: noop },
		"$lib/notifications": { notify_missing_programs: noop },
		"$service/asusctl": { asusctl: service },
		"$service/sleep_inhibitor": {
			sleep_inhibitor: { inhibited: () => false, toggle: noop },
		},
		"$lib/windowing": {
			on_window_toggle: (_name, callback) => {
				on_toggle = callback
				return noop
			},
		},
	}
	const { PowerProfiles } = await load_module(
		"widget/Bar/components/QuickSettings/components/PowerProfiles.tsx",
		widget_imports,
	)
	PowerProfiles.Selector()
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
	assert.equal(asus.ac_hz.peek(), 120)
	assert.deepEqual(messages, [])
	panel.availableModes = ["1920x1080@60", "1920x1080@120"]
	assert.equal((await service.set_profile("Performance")).ok, true)
	assert.deepEqual(messages, [rule("1920x1080@120")])
})

for (const order of ["observer first", "manual first", "observer removed"])
	test(`deferred ${order} monitor query preserves explicit policy and newest metadata`, async () => {
		const requests: ((value: result.result<string>) => void)[] = []
		const panel = edp_panel()
		let deferred = false
		const { service, messages, notifications, handlers, option_changes, asus } =
			await fixture({
				run: async (args) => {
					if (args[0] === "asusctl")
						return ok(args[2] === "set" ? "" : "Active profile: Balanced")
					if (!deferred) return ok(JSON.stringify([panel]))
					return new Promise((resolve) => requests.push(resolve))
				},
			})
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
		let expected: string[] = []
		if (order === "observer first") expected = [rule("1920x1080@144")]
		if (order === "manual first") expected = [rule("1920x1080@120")]
		assert.deepEqual(messages, expected)
		if (order === "manual first") {
			messages.length = 0
			asus.ac_hz.set(60)
			option_changes[0]()
			asus.ac_hz.set(120)
			option_changes[0]()
			assert.equal(requests.length, 4)
			requests[3](ok(JSON.stringify([panel])))
			await tick()
			requests[2](ok(JSON.stringify([panel])))
			await tick()
			assert.deepEqual(messages, [rule("1920x1080@120")])
		}
	})

function error_log(t) {
	const spy = t.mock.method(console, "error", () => {})
	return () => spy.mock.calls.map((call) => call.arguments)
}

test("monitor read and parse failures are logged and keep the last observation", async (t) => {
	const errors = error_log(t)
	const failure = new Error("hyprctl failed")
	let output: result.result<string> = ok(JSON.stringify([edp_panel()]))
	const { service, messages, handlers, option_changes } = await fixture({
		run: async (args) => {
			if (args[0] === "hyprctl") return output
			return ok("Active profile: Balanced")
		},
	})
	messages.length = 0
	output = err(failure)
	option_changes[0]()
	await tick()
	assert.deepEqual(errors(), [
		["asusctl.update_monitor_configuration: Failed to read monitors", failure],
	])
	output = ok("{broken")
	option_changes[0]()
	await tick()
	assert.equal(errors().length, 2)
	assert.equal(
		errors()[1][0],
		"asusctl.update_monitor_configuration: Failed to parse monitors",
	)
	assert.ok(errors()[1][1] instanceof SyntaxError)
	output = ok(JSON.stringify({ name: "eDP-1" }))
	handlers.get("monitor-added")()
	option_changes[0]()
	await tick()
	assert.equal(errors().length, 2)
	assert.deepEqual(service.refreshRates, [60, 120])
	assert.deepEqual(messages, [])
})

test("a superseded observer drops its failed read silently", async (t) => {
	const errors = error_log(t)
	const requests: ((value: result.result<string>) => void)[] = []
	let deferred = false
	const { handlers } = await fixture({
		run: async (args) => {
			if (args[0] === "asusctl") return ok("Active profile: Balanced")
			if (!deferred) return ok(JSON.stringify([edp_panel()]))
			return new Promise((resolve) => requests.push(resolve))
		},
	})
	deferred = true
	handlers.get("monitor-added")()
	handlers.get("monitor-removed")()
	requests[0](err(new Error("stale")))
	await tick()
	assert.deepEqual(errors(), [])
	const failure = new Error("current")
	requests[1](err(failure))
	await tick()
	assert.deepEqual(errors(), [
		["asusctl.update_monitor_configuration: Failed to read monitors", failure],
	])
})

test("a failed profile read marks the service unavailable and skips policy", async (t) => {
	const errors = error_log(t)
	const failure = new Error("asusd down")
	const { service, messages, notifications } = await fixture({
		run: async (args) => {
			if (args[0] === "asusctl") return err(failure)
			return ok(JSON.stringify([edp_panel()]))
		},
	})
	assert.equal(service.available, false)
	assert.deepEqual(errors(), [["asusctl.initialize:", failure]])
	assert.deepEqual(messages, [])
	assert.deepEqual(notifications, [])
})

test("an unknown active profile is rejected with the parsed value", async (t) => {
	const errors = error_log(t)
	const { service } = await fixture({ run: profile_reader("Turbo") })
	assert.equal(service.available, false)
	assert.equal(errors()[0][0], "asusctl.initialize:")
	assert.equal(errors()[0][1].message, "Unexpected profile value: Turbo")
	const refreshed = await service.refresh()
	assert.equal(refreshed.ok, false)
})

test("refresh reads the graphics mode when supergfxctl exists", async (t) => {
	const errors = error_log(t)
	let mode: result.result<string> = ok("Integrated\n")
	const reader = profile_reader("Quiet")
	const { service, notifications } = await fixture({
		programs: ["asusctl", "supergfxctl"],
		run: async (args) => {
			if (args[0] === "supergfxctl") return mode
			return reader(args)
		},
	})
	assert.equal(service.mode, "Integrated")
	assert.equal(service.profile, "Quiet")
	assert.deepEqual(
		notifications.filter((name) => name !== "refresh-rates"),
		["available", "profile", "mode"],
	)
	const failure = new Error("no supergfxd")
	mode = err(failure)
	assert.equal((await service.refresh()).ok, true)
	mode = ok("Dedicated")
	assert.equal((await service.refresh()).ok, true)
	assert.equal(service.mode, "Integrated")
	assert.deepEqual(errors()[0], [
		"asusctl.initialize: Failed to read mode",
		failure,
	])
	assert.equal(errors()[1][0], "asusctl.initialize: Failed to parse mode")
	assert.equal(errors()[1][1].message, "Unexpected mode value: Dedicated")
})

test("set_profile rejects unknown profiles and reports a failed write", async () => {
	const failure = new Error("permission denied")
	let fail_write = true
	const reader = profile_reader("Balanced", () => [
		{ ...edp_panel(), refreshRate: 120 },
	])
	const { service, messages, notifications } = await fixture({
		run: async (args) => {
			if (args[2] === "set" && fail_write) return err(failure)
			return reader(args)
		},
	})
	assert.deepEqual(messages, [])
	notifications.length = 0
	const unknown = await service.set_profile("Turbo")
	assert.equal(unknown.ok, false)
	assert.equal(unknown.err.message, "Unexpected profile value: Turbo")
	const failed = await service.set_profile("Quiet")
	assert.deepEqual(failed, err(failure))
	assert.equal(service.profile, "Balanced")
	assert.deepEqual(notifications, [])
	fail_write = false
	assert.deepEqual(await service.set_profile("Quiet"), ok(undefined))
	assert.equal(service.profile, "Quiet")
	assert.deepEqual(messages, [rule("1920x1080@60")])
})

test("policy snaps stored rates to the nearest available mode and Quiet uses battery", async () => {
	const panel = edp_panel()
	panel.refreshRate = 120
	panel.availableModes = [
		"1920x1080@59.94",
		"1920x1080@165",
		"1920x1080@0",
		"1280x720@60",
	]
	const { service, messages, asus } = await fixture({
		run: profile_reader("Quiet", () => [panel]),
	})
	assert.deepEqual(service.refreshRates, [60, 165])
	assert.equal(asus.ac_hz.peek(), 165)
	assert.equal(asus.bat_hz.peek(), 60)
	assert.deepEqual(messages, [rule("1920x1080@59.94")])
})

test("a disabled internal panel lists its rates but applies nothing", async () => {
	const panel = { ...edp_panel(), disabled: true, refreshRate: 60 }
	const { service, messages, asus, option_changes } = await fixture({
		run: profile_reader("Balanced", () => [panel]),
	})
	assert.deepEqual(service.refreshRates, [60, 120])
	assert.deepEqual(messages, [])
	asus.ac_hz.set(60)
	for (const changed of option_changes) changed()
	await tick()
	assert.deepEqual(messages, [])
	assert.equal(asus.ac_hz.peek(), 60)
	assert.equal(asus.bat_hz.peek(), 60)
})

test("a missing or malformed internal panel applies nothing and lists no rates", async () => {
	for (const monitors of [
		[{ ...edp_panel(), name: "DP-1" }],
		[{ ...edp_panel(), scale: 0 }],
		[{ ...edp_panel(), transform: 0.5 }],
		[{ ...edp_panel(), disabled: undefined }],
		[{ ...edp_panel(), availableModes: [60] }],
		[{ ...edp_panel(), availableModes: undefined }],
	]) {
		const { service, messages, asus } = await fixture({
			run: profile_reader("Balanced", () => monitors),
		})
		assert.deepEqual(service.refreshRates, [])
		assert.deepEqual(messages, [])
		assert.equal(asus.ac_hz.peek(), 120)
	}
})

test("a panel already at the target rate is left alone", async () => {
	const panel = { ...edp_panel(), refreshRate: 120.04 }
	const { messages } = await fixture({
		run: profile_reader("Balanced", () => [panel]),
	})
	assert.deepEqual(messages, [])
})

test("a rejected refresh rate rule is logged", async (t) => {
	const errors = error_log(t)
	const { messages } = await fixture({ run: profile_reader(), reply: "error" })
	assert.deepEqual(messages, [rule("1920x1080@120")])
	assert.equal(errors()[0][0], "asusctl.monitor: Failed to apply refresh rate")
})

test("without asusctl the service stays idle and refuses work", async () => {
	const commands: string[][] = []
	const { service, handlers, option_changes } = await fixture({
		programs: [],
		run: async (args) => {
			commands.push(args)
			return ok("")
		},
	})
	assert.equal(handlers.size, 0)
	assert.equal(option_changes.length, 0)
	assert.equal((await service.refresh()).err.message, "asusctl is unavailable")
	assert.equal(
		(await service.set_profile("Quiet")).err.message,
		"asusctl is unavailable",
	)
	assert.deepEqual(commands, [])
})

test("a refresh that started before a profile change cannot revert it", async () => {
	const reads: ((value: result.result<string>) => void)[] = []
	let deferred = false
	const reader = profile_reader()
	const { service } = await fixture({
		run: async (args) => {
			if (deferred && args[2] === "get")
				return new Promise((resolve) => reads.push(resolve))
			return reader(args)
		},
	})
	deferred = true
	const refreshed = service.refresh()
	assert.equal((await service.set_profile("Quiet")).ok, true)
	reads[0](ok("Active profile: Balanced"))
	assert.equal((await refreshed).ok, true)
	assert.equal(service.profile, "Quiet")
})
