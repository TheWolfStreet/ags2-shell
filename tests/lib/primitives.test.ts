import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { load_hyprland, with_hyprland_command } from "../helpers.ts"
import { load_module } from "../load_module.ts"
import * as lua from "../../lib/lua.ts"
import * as results from "../../lib/result.ts"

class NativeError extends Error {
	code: number
	constructor(code: number) {
		super(String(code))
		this.code = code
	}
	matches(_domain, code) {
		return code === this.code
	}
}

test("ensure operations verify existing entry types and close created streams", async () => {
	let type = 2
	let closed = 0
	let exists = true
	let close_error = false
	const file = {
		make_directory_with_parents() {
			if (exists) throw new NativeError(1)
		},
		query_info: () => ({ get_file_type: () => type }),
		get_parent: () => ({ get_path: () => "/parent" }),
		create() {
			if (exists) throw new NativeError(1)
			return {
				close() {
					closed++
					if (close_error) throw new NativeError(2)
					return true
				},
			}
		},
	}
	const module = await load_module("lib/files.ts", {
		"gi://Gio": {
			default: {
				File: { new_for_path: () => file },
				FileType: { DIRECTORY: 2, REGULAR: 3 },
				FileQueryInfoFlags: { NONE: 0 },
				FileCreateFlags: { PRIVATE: 1 },
				io_error_quark: () => 0,
				IOErrorEnum: { EXISTS: 1 },
			},
		},
		"gi://GLib": { default: { Error: NativeError } },
		"$lib/result": results,
	})
	assert.equal(module.ensure_directory("/parent").ok, true)
	type = 3
	assert.equal(module.ensure_directory("/parent").ok, false)
	type = 2
	exists = false
	assert.equal(module.ensure_file("/parent/file").ok, true)
	assert.equal(closed, 1)
	close_error = true
	assert.equal(module.ensure_file("/parent/file").ok, false)
	assert.equal(closed, 2)
})

test("launch uses argv quoting and returns dispatch failure instead of hiding it", async () => {
	const commands: string[] = []
	let response = "ok"
	const module = await load_module("lib/apps.ts", {
		"gi://AstalApps": { default: {} },
		"gi://GioUnix": { default: { DesktopAppInfo: { new: () => null } } },
		"gi://GLib": {
			default: {
				shell_quote: (value) => `'${value.replaceAll("'", "'\\''")}'`,
			},
		},
		"$lib/hyprland": with_hyprland_command({
			hyprland: {
				message_async: async (command) => {
					commands.push(command)
					return response
				},
			},
		}),
		"$lib/result": results,
	})
	assert.equal(
		(await module.launch_program(["program", "file with space", "quote'"])).ok,
		true,
	)
	assert.equal(
		commands[0],
		`dispatch hl.dsp.exec_cmd("'program' 'file with space' 'quote'\\\\'''")`,
	)
	response = "Invalid dispatcher"
	assert.equal((await module.launch_program(["program"])).ok, false)
	assert.equal((await module.launch_program([])).ok, false)
	assert.equal(commands.length, 2)
	assert.equal(
		(
			await module.launch_app({
				get_entry: () => "missing.desktop",
				launch: () => false,
			})
		).ok,
		false,
	)
})

test("icon substitutions never return inherited object members", async () => {
	const module = await load_module("lib/icons.ts", {})
	for (const name of ["constructor", "toString", "__proto__"])
		assert.equal(module.substitute_icon_name(name), name)
	assert.equal(module.substitute_icon_name(""), "image-missing-symbolic")
})

function command_fixture({
	spawn_error = null as Error | null,
	finish_error = null as Error | null,
	start_error = null as Error | null,
	successful = true,
	stdout = "  out \n",
	stderr = "",
} = {}) {
	const state = {
		forced: false,
		removed: [] as number[],
		deadlines: [] as { ms: number; fire: () => unknown }[],
		finish: () => {},
	}
	const process = {
		force_exit() {
			state.forced = true
		},
		communicate_utf8_async(_input, _cancellable, callback) {
			if (start_error) throw start_error
			state.finish = () => callback(process, {})
		},
		communicate_utf8_finish() {
			if (finish_error) throw finish_error
			return [true, stdout, stderr]
		},
		get_successful: () => successful,
	}
	const imports = {
		"gi://Gio": {
			default: {
				Subprocess: {
					new: () => {
						if (spawn_error) throw spawn_error
						return process
					},
				},
				SubprocessFlags: { STDOUT_PIPE: 1, STDERR_PIPE: 2 },
			},
		},
		"gi://GLib": {
			default: {
				PRIORITY_DEFAULT: 0,
				SOURCE_REMOVE: false,
				timeout_add: (_priority, ms, fire) => {
					state.deadlines.push({ ms, fire })
					return 42
				},
				Source: { remove: (id) => state.removed.push(id) },
			},
		},
		"$lib/result": results,
	}
	return { state, imports }
}

test("run command returns trimmed output and clears its deadline", async () => {
	const { state, imports } = command_fixture()
	const module = await load_module("lib/commands.ts", imports)
	const pending = module.run_command(["tool", "arg"], { timeout_ms: 300 })
	await Promise.resolve()
	assert.equal(state.deadlines[0].ms, 300)
	state.finish()
	assert.deepEqual(await pending, { ok: true, value: "out" })
	assert.deepEqual(state.removed, [42])
})

test("run command reports spawn and exchange failures", async () => {
	const spawn_error = new Error("no such program")
	const spawned = command_fixture({ spawn_error })
	const spawn_module = await load_module("lib/commands.ts", spawned.imports)
	assert.deepEqual(await spawn_module.run_command(["tool"]), {
		ok: false,
		err: spawn_error,
	})
	assert.equal(spawned.state.deadlines.length, 0)

	const finish_error = new Error("pipe broke")
	const broken = command_fixture({ finish_error })
	const broken_module = await load_module("lib/commands.ts", broken.imports)
	const pending = broken_module.run_command(["tool"])
	await Promise.resolve()
	broken.state.finish()
	assert.deepEqual(await pending, { ok: false, err: finish_error })
	assert.deepEqual(broken.state.removed, [42])
})

test("run command reports an exchange that cannot start and clears its deadline", async () => {
	const start_error = new Error("bad arguments")
	const { state, imports } = command_fixture({ start_error })
	const module = await load_module("lib/commands.ts", imports)
	assert.deepEqual(await module.run_command(["tool"]), {
		ok: false,
		err: start_error,
	})
	assert.deepEqual(state.removed, [42])
	assert.equal(state.forced, true)
})

test("run command reports a failed exit with stderr or the program name", async () => {
	for (const [stderr, message] of [
		["  bad input \n", "bad input"],
		["  ", "tool failed"],
	]) {
		const { state, imports } = command_fixture({ successful: false, stderr })
		const module = await load_module("lib/commands.ts", imports)
		const pending = module.run_command(["tool"])
		await Promise.resolve()
		state.finish()
		const ran = await pending
		assert.equal(ran.ok, false)
		assert.equal(ran.err.message, message)
	}
})

test("run command deadline kills the process and reports the timeout", async () => {
	const { state, imports } = command_fixture()
	const module = await load_module("lib/commands.ts", imports)
	const pending = module.run_command(["tool"])
	await Promise.resolve()
	state.deadlines[0].fire()
	assert.equal(state.forced, true)
	state.finish()
	const ran = await pending
	assert.equal(ran.ok, false)
	assert.equal(ran.err.message, "Timed out running tool")
	assert.deepEqual(state.removed, [])
})

test("live monitor sync retries unexpected replies and reports names", async () => {
	let reply = "{}"
	const synced: string[][] = []
	const retries: (() => void)[] = []
	const module = await load_hyprland({
		hyprland: { message: () => reply, connect: () => 1, disconnect() {} },
		app: { connect: () => 1, disconnect() {} },
		timeout: (_ms, callback) => {
			retries.push(callback)
			return { cancel() {} }
		},
	})
	module.watch_live_monitors((names) => synced.push([...names]))
	assert.equal(synced.length, 0)
	assert.equal(retries.length, 1)
	reply = "not json"
	retries[0]()
	assert.equal(synced.length, 0)
	assert.equal(retries.length, 2)
	reply = "[null]"
	retries[1]()
	assert.equal(synced.length, 0)
	assert.equal(retries.length, 3)
	reply = JSON.stringify([{ name: "eDP-1" }, { id: 3 }, { name: "HDMI-A-1" }])
	retries[2]()
	assert.deepEqual(synced, [["eDP-1", "HDMI-A-1"]])
	assert.equal(retries.length, 3)
})

test("live monitor sync reports why the query kept failing", async (t) => {
	let reply = "[]"
	const retries: (() => void)[] = []
	const logged: unknown[][] = []
	t.mock.method(console, "error", (...args) => logged.push(args))
	const module = await load_hyprland({
		hyprland: { message: () => reply, connect: () => 1, disconnect() {} },
		app: { connect: () => 1, disconnect() {} },
		timeout: (_ms, callback) => {
			retries.push(callback)
			return { cancel() {} }
		},
	})
	module.watch_live_monitors(() => {})
	for (const [failing, expected] of [
		["{}", /Unexpected monitor reply/],
		["not json", /JSON/],
	] as const) {
		reply = failing
		logged.length = 0
		const first = retries.length
		module.watch_live_monitors(() => {})
		while (retries.length > first && logged.length === 0)
			retries[retries.length - 1]()
		assert.equal(logged.length, 1)
		assert.equal(logged[0][0], "hyprland.monitors: Failed to query monitors")
		assert.match(String(logged[0][1]), expected)
	}
})

test("hyprland command accepts only all-ok replies and returns IPC failures", async () => {
	let reply: Promise<string> = Promise.resolve("ok")
	const module = await load_hyprland({
		hyprland: { message_async: () => reply },
	})
	assert.deepEqual(await module.hyprland_command("dispatch x"), {
		ok: true,
		value: undefined,
	})
	reply = Promise.resolve("ok\n\nok\n")
	assert.equal((await module.hyprland_command("dispatch x")).ok, true)
	for (const text of ["", "ok\nInvalid dispatcher"]) {
		reply = Promise.resolve(text)
		const rejected = await module.hyprland_command("dispatch x")
		assert.equal(rejected.ok, false)
		assert.equal(rejected.err.message, `Hyprland rejected dispatch x: ${text}`)
	}
	const socket_error = new Error("EAGAIN")
	reply = Promise.reject(socket_error)
	assert.deepEqual(await module.hyprland_command("dispatch x"), {
		ok: false,
		err: socket_error,
	})
})

test("lua strings escape quotes, backslashes and control bytes", async () => {
	assert.equal(lua.lua_string('say "hi" \\ now'), '"say \\"hi\\" \\\\ now"')
	assert.equal(lua.lua_string("a\nb\x00\x7f"), '"a\\010b\\000\\127"')
	assert.equal(lua.lua_string(""), '""')
})

test("wallpaper palettes keep their exact colors for neutral and tinted samples", async () => {
	const { build_wallpaper_palette } = await import("../../lib/colors.ts")
	const gray = (value: number) => ({ r: value, g: value, b: value })
	const neutral = {
		dark: {
			bg: "#0b0b0b",
			fg: "#e8e8e8",
			widget: "#e8e8e8",
			border: "#7a7a7a",
			primary_bg: "#d7d7d7",
			primary_fg: "#000000",
			error_bg: "#ef6661",
		},
		light: {
			bg: "#f8f8f8",
			fg: "#161616",
			widget: "#161616",
			border: "#5d5d5d",
			primary_bg: "#292929",
			primary_fg: "#ffffff",
			error_bg: "#ba3535",
		},
	}
	assert.equal(build_wallpaper_palette([]), null)
	assert.deepEqual(
		build_wallpaper_palette([gray(0.2), gray(0.5), gray(0.8)]),
		neutral,
	)
	assert.deepEqual(
		build_wallpaper_palette([
			{ r: 0.9, g: 0.1, b: 0.1 },
			...Array.from({ length: 300 }, () => gray(0.4)),
		]),
		neutral,
	)
	assert.deepEqual(
		build_wallpaper_palette([
			{ r: 0.7, g: 0.75, b: 0.8 },
			{ r: 0.72, g: 0.74, b: 0.82 },
		]),
		neutral,
	)
	assert.deepEqual(build_wallpaper_palette([{ r: 0.1, g: 0.8, b: 0.2 }]), {
		dark: {
			bg: "#070d07",
			fg: "#e2ebe2",
			widget: "#e2ebe2",
			border: "#6e806d",
			primary_bg: "#5ec660",
			primary_fg: "#080d08",
			error_bg: "#ef6661",
		},
		light: {
			bg: "#f2fcf1",
			fg: "#121812",
			widget: "#121812",
			border: "#526351",
			primary_bg: "#289630",
			primary_fg: "#080d08",
			error_bg: "#ba3535",
		},
	})
	assert.deepEqual(
		build_wallpaper_palette([
			{ r: 0.9, g: 0.1, b: 0.1 },
			{ r: 0.8, g: 0.2, b: 0.15 },
			{ r: 0.1, g: 0.2, b: 0.9 },
			gray(0.3),
			{ r: 0.95, g: 0.6, b: 0.1 },
		]),
		{
			dark: {
				bg: "#120807",
				fg: "#f2e4e2",
				widget: "#f2e4e2",
				border: "#8e736f",
				primary_bg: "#fe8070",
				primary_fg: "#100908",
				error_bg: "#ef6661",
			},
			light: {
				bg: "#fff6f5",
				fg: "#1c1412",
				widget: "#1c1412",
				border: "#705652",
				primary_bg: "#cf4a3e",
				primary_fg: "#000000",
				error_bg: "#ba3535",
			},
		},
	)
	assert.deepEqual(
		build_wallpaper_palette([
			{ r: 0, g: 0, b: 0 },
			{ r: 1, g: 1, b: 1 },
			{ r: 0.02, g: 0, b: 0.3 },
		]),
		{
			dark: {
				bg: "#080b13",
				fg: "#e3e8f2",
				widget: "#e3e8f2",
				border: "#717a90",
				primary_bg: "#88a7fd",
				primary_fg: "#090b10",
				error_bg: "#ef6661",
			},
			light: {
				bg: "#f6f8ff",
				fg: "#13161d",
				widget: "#13161d",
				border: "#555d72",
				primary_bg: "#5776d8",
				primary_fg: "#090b10",
				error_bg: "#ba3535",
			},
		},
	)
	assert.deepEqual(
		build_wallpaper_palette([
			{ r: 1, g: 1, b: 0 },
			{ r: 0.9, g: 0.9, b: 0.1 },
		]),
		{
			dark: {
				bg: "#0c0c04",
				fg: "#e8e9de",
				widget: "#e8e9de",
				border: "#7b7c65",
				primary_bg: "#b2b218",
				primary_fg: "#0b0c06",
				error_bg: "#ef6661",
			},
			light: {
				bg: "#f9faec",
				fg: "#16170f",
				widget: "#16170f",
				border: "#5f6049",
				primary_bg: "#828316",
				primary_fg: "#0b0c06",
				error_bg: "#ba3535",
			},
		},
	)
})

test("brightness icons step through their thresholds", async () => {
	const icons = await import("../../lib/icons.ts")
	const screen = [0, 0.1, 0.25, 0.5, 0.75, 1].map((percent) =>
		icons.get_brightness_icon(percent),
	)
	assert.deepEqual(screen, [
		"display-brightness-off-symbolic",
		"display-brightness-low-symbolic",
		"display-brightness-medium-symbolic",
		"display-brightness-high-symbolic",
		"display-brightness-symbolic",
		"display-brightness-symbolic",
	])
	const keyboard = [0, 0.3, 0.4, 0.8].map((percent) =>
		icons.get_brightness_icon(percent, "keyboard"),
	)
	assert.deepEqual(keyboard, [
		"keyboard-brightness-off-symbolic",
		"keyboard-brightness-low-symbolic",
		"keyboard-brightness-medium-symbolic",
		"keyboard-brightness-high-symbolic",
	])
	assert.equal(
		icons.substitute_icon_name("Playback"),
		"sound-wave-alt-symbolic",
	)
	assert.equal(icons.substitute_icon_name("", "fallback"), "fallback")
	assert.equal(icons.substitute_icon_name("custom"), "custom")
})

function signature_file(fail: Error | null) {
	return {
		query_info: (attributes: string) => {
			if (fail) throw fail
			assert.equal(
				attributes,
				"standard::size,time::modified,time::modified-usec,etag::value",
			)
			return {
				get_size: () => 12,
				get_attribute_uint64: () => 34,
				get_attribute_uint32: () => 56,
				get_attribute_string: () => null,
			}
		},
	}
}

test("file signatures join size, mtime and etag and treat a missing file as absent", async () => {
	let failure: Error | null = null
	const module = await load_module("lib/files.ts", {
		"gi://Gio": {
			default: {
				File: { new_for_path: () => signature_file(failure) },
				FileQueryInfoFlags: { NONE: 0 },
				io_error_quark: () => 0,
				IOErrorEnum: { EXISTS: 1, NOT_FOUND: 2 },
			},
		},
		"gi://GLib": {
			default: {
				Error: NativeError,
				FileTest: { EXISTS: 1 },
				file_test: (path: string) => path === "/present",
			},
		},
		"$lib/result": results,
	})
	assert.deepEqual(module.query_file_signature("/x"), {
		ok: true,
		value: { value: "12:34:56:", size: 12 },
	})
	failure = new NativeError(2)
	assert.deepEqual(module.query_file_signature("/x"), { ok: true, value: null })
	failure = new NativeError(1)
	assert.deepEqual(module.query_file_signature("/x"), {
		ok: false,
		err: failure,
	})
	failure = new Error("plain")
	assert.deepEqual(module.query_file_signature("/x"), {
		ok: false,
		err: failure,
	})
	assert.equal(module.is_exists_error(new NativeError(1)), true)
	assert.equal(module.is_exists_error(new NativeError(2)), false)
	assert.equal(module.is_exists_error(new Error("1")), false)
	assert.equal(module.file_exists("/present"), true)
	assert.equal(module.file_exists("/absent"), false)
	assert.equal(module.valid_image_dimensions(8192, 4882), true)
	assert.equal(module.valid_image_dimensions(8192, 4883), false)
	assert.equal(module.valid_image_dimensions(8193, 1), false)
	assert.equal(module.valid_image_dimensions(0, 1), false)
})

test("ensure file reports each failure with its reason", async () => {
	let create_error: Error | null = null
	let close_result: boolean = true
	let type = 3
	let parent: string | null = "/parent"
	let mkdir_error: Error | null = null
	const file = {
		make_directory_with_parents() {
			if (mkdir_error) throw mkdir_error
		},
		query_info: () => ({ get_file_type: () => type }),
		get_parent: () => (parent ? { get_path: () => parent } : null),
		create() {
			if (create_error) throw create_error
			return { close: () => close_result }
		},
	}
	const module = await load_module("lib/files.ts", {
		"gi://Gio": {
			default: {
				File: { new_for_path: () => file },
				FileType: { DIRECTORY: 2, REGULAR: 3 },
				FileQueryInfoFlags: { NONE: 0 },
				FileCreateFlags: { PRIVATE: 1 },
				io_error_quark: () => 0,
				IOErrorEnum: { EXISTS: 1 },
			},
		},
		"gi://GLib": { default: { Error: NativeError } },
		"$lib/result": results,
	})
	close_result = false
	const unclosed = module.ensure_file("/parent/file")
	assert.equal(
		unclosed.err.message,
		"Could not close created file: /parent/file",
	)
	close_result = true
	create_error = new NativeError(1)
	assert.deepEqual(module.ensure_file("/parent/file"), {
		ok: true,
		value: undefined,
	})
	type = 2
	assert.equal(
		module.ensure_file("/parent/file").err.message,
		"Not a regular file: /parent/file",
	)
	create_error = new Error("denied")
	assert.deepEqual(module.ensure_file("/parent/file"), {
		ok: false,
		err: create_error,
	})
	parent = null
	mkdir_error = new Error("never called")
	create_error = null
	assert.equal(module.ensure_file("file").ok, true)
	parent = "/parent"
	assert.deepEqual(module.ensure_file("/parent/file"), {
		ok: false,
		err: mkdir_error,
	})
	mkdir_error = new NativeError(1)
	type = 3
	assert.equal(
		module.ensure_directory("/parent").err.message,
		"Not a directory: /parent",
	)
})

test("toggle class flips by default and follows an explicit state", async () => {
	const module = await load_module("lib/ui.ts", {
		ags: {},
		"ags/gtk4": { Gtk: { DialogError: { DISMISSED: 2 } } },
		"gi://Pango": {
			default: {
				SCALE: 1024,
				FontDescription: {
					from_string: (font: string) => ({
						get_size: () => (font === "Sans 13" ? 13 * 1024 : 0),
					}),
				},
			},
		},
	})
	const classes = new Set<string>()
	const widget = {
		has_css_class: (name: string) => classes.has(name),
		add_css_class: (name: string) => classes.add(name),
		remove_css_class: (name: string) => classes.delete(name),
	}
	module.toggle_class(widget, "active")
	assert.equal(classes.has("active"), true)
	module.toggle_class(widget, "active")
	assert.equal(classes.has("active"), false)
	module.toggle_class(widget, "active", false)
	assert.equal(classes.has("active"), false)
	module.toggle_class(widget, "active", true)
	module.toggle_class(widget, "active", true)
	assert.equal(classes.has("active"), true)
	assert.equal(module.is_dialog_dismissed({ code: 2 }), true)
	assert.equal(module.is_dialog_dismissed({ code: 1 }), false)
	assert.equal(module.is_dialog_dismissed(null), false)
	assert.equal(module.font_size("Sans 13"), 13)
	assert.equal(module.font_size("Sans"), 11)
	const read = Object.assign(() => 5, { peek: () => 5 })
	assert.equal(module.read_value(read), 5)
	assert.equal(module.read_value(7), 7)
})

test("three hundred seeded wallpaper samples keep their exact palettes", async () => {
	const { build_wallpaper_palette } = await import("../../lib/colors.ts")
	let seed = 1
	const random = () => {
		seed = (seed * 48271) % 2147483647
		return seed / 2147483647
	}
	const palettes = Array.from({ length: 300 }, () =>
		build_wallpaper_palette(
			Array.from({ length: 1 + Math.floor(random() * 16) }, () => ({
				r: random(),
				g: random() ** 3,
				b: random(),
			})),
		),
	)
	assert.equal(
		createHash("sha256").update(JSON.stringify(palettes)).digest("hex"),
		"29520e51c081738f8ed97cf0346fc66af41164c0a6a23aa4c93bbe0c2f3393ee",
	)
})

test("live monitors keep connectorless and live outputs only", async () => {
	const monitor = (connector: string | null) => ({
		get_connector: () => connector,
	})
	const monitors = [monitor("eDP-1"), monitor("HDMI-A-1"), monitor(null)]
	const module = await load_hyprland({ app: { get_monitors: () => monitors } })
	assert.deepEqual(module.live_monitors(new Set(["HDMI-A-1"])), [
		monitors[1],
		monitors[2],
	])
})

test("guards return a result-returning step as is and turn a throw into an error result", async () => {
	const failure = new Error("boom")
	assert.deepEqual(
		results.guard(() => results.ok(1)),
		{ ok: true, value: 1 },
	)
	assert.deepEqual(
		results.guard(() => results.err(failure)),
		{ ok: false, err: failure },
	)
	assert.deepEqual(
		results.guard(() => {
			throw failure
		}),
		{ ok: false, err: failure },
	)
	assert.deepEqual(await results.guard_async(async () => results.ok(2)), {
		ok: true,
		value: 2,
	})
	assert.deepEqual(
		await results.guard_async(async () => {
			throw failure
		}),
		{ ok: false, err: failure },
	)
})
