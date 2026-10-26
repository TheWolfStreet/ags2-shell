import assert from "node:assert/strict"
import { test } from "node:test"
import { createContext } from "node:vm"
import { load_module } from "../load_module.ts"
import {
	create_state,
	emitter,
	capture_timer,
	immediate_debounce,
	capture_log,
	variant,
	type fake_timer as harness_timer,
} from "../helpers.ts"

function load(
	path: string,
	imports: Record<string, Record<string, unknown>>,
	logger: Partial<Console> = console,
) {
	return load_module(path, imports, createContext({ console: logger }))
}

async function with_files(imports) {
	return {
		...imports,
		"$lib/files": await load("lib/files.ts", {
			"gi://Gio": imports["gi://Gio"],
			"gi://GLib": imports["gi://GLib"],
		}),
	}
}

type emitter = ReturnType<typeof emitter>
type notification_action = { id: string; label: string }
type stored_record = {
	summary: string
	body: string
	transient: boolean
	resident: boolean
	actions: notification_action[]
}
type daemon_notification = emitter & {
	get_actions(): notification_action[]
	summary?: string
	body?: string
}
type dbus_call = {
	destination: string
	path: string
	iface: string
	method: string
	args: any
}
function notification_harness(
	owner = ":1.shell",
	stored: stored_record[] | null = null,
) {
	const shell = emitter()
	const daemon = Object.assign(emitter(), {
		current: null as daemon_notification | null,
		get_notification() {
			return this.current
		},
	})
	const make_notification = (record: stored_record) =>
		Object.assign(emitter(), {
			id: 7,
			summary: record.summary,
			body: record.body,
			transient: record.transient,
			resident: record.resident,
			get_actions: () => record.actions,
			dismiss_count: 0,
			dismiss() {
				this.dismiss_count++
				daemon.current = null
				if (stored) stored.length = 0
				daemon.emit("resolved", 7)
			},
		})
	if (stored?.length) daemon.current = make_notification(stored[0])
	const callbacks: string[][] = []
	const calls: dbus_call[] = []
	const timers: harness_timer[] = []
	const session = {
		get_unique_name: () => ":1.shell",
		call(
			destination,
			path,
			iface,
			method,
			args,
			_reply,
			_flags,
			_ms,
			_cancellable,
			callback,
		) {
			calls.push({ destination, path, iface, method, args })
			if (method === "Notify" && stored) {
				const [, , , summary, body, pairs, hints] = args.value
				const record = {
					summary,
					body,
					transient: hints.transient?.value === true,
					resident: hints.resident?.value === true,
					actions: Array.from(
						{ length: pairs.length / 2 },
						(_value, index) => ({
							id: pairs[2 * index],
							label: pairs[2 * index + 1],
						}),
					),
				}
				if (!record.transient) stored.splice(0, stored.length, record)
				daemon.current = make_notification(record)
			}
			queueMicrotask(() =>
				callback(
					{
						call_finish: () => ({
							recursiveUnpack: () =>
								method === "GetNameOwner" ? [owner] : [7],
						}),
					},
					{},
				),
			)
		},
	}
	const imports = {
		ags: {
			createState: create_state,
		},
		"ags/process": {
			execAsync: (args) => {
				callbacks.push(args)
				return Promise.resolve("")
			},
		},
		"$lib/app": { default: shell },
		"$lib/time": {
			timeout: capture_timer(timers),
		},
		"gi://AstalNotifd": { default: { get_default: () => daemon } },
		"gi://Gio": { default: { DBus: { session }, DBusCallFlags: { NONE: 0 } } },
		"gi://GLib": {
			default: {
				find_program_in_path: (name) => name,
				Variant: variant,
				VariantType: class {},
				uuid_string_random: (() => {
					let n = 0
					return () => `opaque-${++n}`
				})(),
			},
		},
	}
	return { shell, daemon, calls, callbacks, timers, imports }
}

test("notification actions execute only bound argument arrays, then detach on replacement", async () => {
	const h = notification_harness()
	const module = await load("lib/notifications.ts", h.imports)
	const notification = Object.assign(emitter(), {
		get_actions: () => [{ id: "ags2-shell:opaque-1", label: "View" }],
		resident: false,
		dismiss_count: 0,
		dismiss() {
			this.dismiss_count++
			h.daemon.current = null
			h.daemon.emit("resolved", 7)
		},
	})
	notification.connect("invoked", () => {
		if (!notification.resident) notification.dismiss()
	})
	h.daemon.current = notification
	const old_call = h.imports["gi://Gio"].default.DBus.session.call
	h.imports["gi://Gio"].default.DBus.session.call = (...args) => {
		if (args[3] === "Notify")
			notification.resident = args[4].value[6].resident?.value === true
		old_call(...args)
	}
	const result = await module.notify({
		actions: [{ label: "View", argv: ["xdg-open", "file with space"] }],
	})
	assert.equal(result.ok, true)
	assert.equal(h.calls[1].destination, ":1.shell")
	assert.equal(h.calls[1].args.value[6].transient, undefined)
	assert.equal(h.calls[1].args.value[6].resident.value, true)
	notification.emit("invoked", "arbitrary executable")
	assert.equal(h.callbacks.length, 0)
	assert.equal(notification.dismiss_count, 0)
	notification.emit("invoked", "ags2-shell:opaque-1")
	assert.deepEqual(
		h.callbacks.map((argv) => Array.from(argv)),
		[["xdg-open", "file with space"]],
	)
	assert.equal(notification.dismiss_count, 1)
	assert.equal(h.daemon.listeners.size, 0)
	assert.equal(notification.listeners.size, 1)
	notification.emit("invoked", "ags2-shell:opaque-1")
	assert.equal(h.callbacks.length, 1)
})

test("notification replacement detaches bound action handler", async () => {
	const h = notification_harness()
	const module = await load("lib/notifications.ts", h.imports)
	const notification = Object.assign(emitter(), {
		get_actions: () => [{ id: "ags2-shell:opaque-1", label: "View" }],
	})
	h.daemon.current = notification
	assert.equal(
		(
			await module.notify({
				actions: [{ label: "View", argv: ["xdg-open", "file"] }],
			})
		).ok,
		true,
	)
	h.daemon.current = Object.assign(emitter(), { get_actions: () => [] })
	h.daemon.emit("notified", 7, true)
	assert.equal(h.daemon.listeners.size, 0)
	assert.equal(notification.listeners.size, 0)
	notification.emit("invoked", "ags2-shell:opaque-1")
	assert.equal(h.callbacks.length, 0)
})

test("competing daemon cannot receive executable actions or leave listeners", async () => {
	const h = notification_harness(":1.other")
	const module = await load("lib/notifications.ts", h.imports)
	const result = await module.notify({
		actions: [{ label: "View", argv: ["xdg-open", "file"] }],
	})
	assert.equal(result.ok, false)
	assert.deepEqual(
		h.calls.map((call) => call.method),
		["GetNameOwner"],
	)
	assert.equal(h.daemon.listeners.size, 0)
})

test("replaced notification with different action keys is refused", async () => {
	const h = notification_harness()
	const module = await load("lib/notifications.ts", h.imports)
	h.daemon.current = Object.assign(emitter(), {
		get_actions: () => [{ id: "other", label: "View" }],
	})
	const result = await module.notify({
		actions: [{ label: "View", argv: ["xdg-open", "file"] }],
	})
	assert.equal(result.ok, false)
	assert.equal(h.daemon.listeners.size, 0)
	h.daemon.current!.emit("invoked", "other")
	assert.equal(h.callbacks.length, 0)
})

test("notification missing one of the sent actions is refused", async () => {
	const h = notification_harness()
	const module = await load("lib/notifications.ts", h.imports)
	h.daemon.current = Object.assign(emitter(), {
		get_actions: () => [{ id: "ags2-shell:opaque-1", label: "View" }],
	})
	const result = await module.notify({
		actions: [
			{ label: "View", argv: ["xdg-open", "file"] },
			{ label: "Copy", argv: ["wl-copy", "file"] },
		],
	})
	assert.equal(result.ok, false)
	assert.equal(h.daemon.listeners.size, 0)
	assert.equal(
		module.notification_action_available("ags2-shell:opaque-1"),
		false,
	)
})

test("dismissed notification releases its actions before any click", async () => {
	const h = notification_harness()
	const module = await load("lib/notifications.ts", h.imports)
	const notification = Object.assign(emitter(), {
		get_actions: () => [{ id: "ags2-shell:opaque-1", label: "View" }],
	})
	h.daemon.current = notification
	const result = await module.notify({
		actions: [{ label: "View", argv: ["xdg-open", "file"] }],
	})
	assert.equal(result.ok, true)
	assert.equal(
		module.notification_action_available("ags2-shell:opaque-1"),
		true,
	)
	h.daemon.emit("resolved", 7)
	assert.equal(
		module.notification_action_available("ags2-shell:opaque-1"),
		false,
	)
	assert.equal(h.daemon.listeners.size, 0)
	assert.equal(notification.listeners.size, 0)
	notification.emit("invoked", "ags2-shell:opaque-1")
	assert.equal(h.callbacks.length, 0)
})

test("pending notification attachment expires and disconnects", async () => {
	const h = notification_harness()
	const module = await load("lib/notifications.ts", h.imports)
	const pending = module.notify({
		actions: [{ label: "View", argv: ["xdg-open", "file"] }],
	})
	for (let i = 0; i < 20 && h.daemon.listeners.size < 2; i++)
		await Promise.resolve()
	assert.equal(h.daemon.listeners.size, 2)
	h.timers[0].callback()
	const result = await pending
	assert.equal(result.ok, false)
	assert.equal(h.daemon.listeners.size, 0)
})

test("shutdown detaches active notification actions", async () => {
	const h = notification_harness()
	const module = await load("lib/notifications.ts", h.imports)
	h.daemon.current = Object.assign(emitter(), {
		get_actions: () => [{ id: "ags2-shell:opaque-1", label: "View" }],
	})
	assert.equal(
		(
			await module.notify({
				actions: [{ label: "View", argv: ["xdg-open", "file"] }],
			})
		).ok,
		true,
	)
	h.shell.emit("shutdown")
	assert.equal(h.daemon.listeners.size, 0)
	assert.equal(h.daemon.current!.listeners.size, 0)
	assert.equal((await module.notify({ summary: "late" })).ok, false)
})

function fail_bus_method(
	h: ReturnType<typeof notification_harness>,
	method: string,
	error: Error,
) {
	const session = h.imports["gi://Gio"].default.DBus.session
	const call = session.call
	session.call = (...args) => {
		const callback = args[9]
		if (args[3] === method)
			args[9] = (_connection, response) =>
				callback(
					{
						call_finish: () => {
							throw error
						},
					},
					response,
				)
		call(...args)
	}
}

test("notification bus failures are returned with their cause", async () => {
	const unavailable = notification_harness()
	const no_bus = new Error("no session bus")
	Object.defineProperty(
		unavailable.imports["gi://Gio"].default.DBus,
		"session",
		{
			get() {
				throw no_bus
			},
		},
	)
	const offline = await load("lib/notifications.ts", unavailable.imports)
	assert.deepEqual(await offline.notify({ summary: "x" }), {
		ok: false,
		err: no_bus,
	})

	const owner = notification_harness()
	const owner_error = new Error("name has no owner")
	fail_bus_method(owner, "GetNameOwner", owner_error)
	const owner_module = await load("lib/notifications.ts", owner.imports)
	assert.deepEqual(
		await owner_module.notify({
			actions: [{ label: "View", argv: ["xdg-open", "file"] }],
		}),
		{ ok: false, err: owner_error },
	)
	assert.deepEqual(
		owner.calls.map((call) => call.method),
		["GetNameOwner"],
	)
	assert.equal(owner.daemon.listeners.size, 0)

	const sent = notification_harness()
	const notify_error = new Error("daemon timed out")
	fail_bus_method(sent, "Notify", notify_error)
	const sent_module = await load("lib/notifications.ts", sent.imports)
	assert.deepEqual(await sent_module.notify({ summary: "x" }), {
		ok: false,
		err: notify_error,
	})
	assert.equal(sent.calls[0].destination, "org.freedesktop.Notifications")
	assert.equal(sent.calls[0].path, "/org/freedesktop/Notifications")
})

test("a bus call that cannot start is returned, not rejected", async () => {
	const h = notification_harness()
	const start_error = new Error("invalid arguments")
	h.imports["gi://Gio"].default.DBus.session.call = () => {
		throw start_error
	}
	const module = await load("lib/notifications.ts", h.imports)
	assert.deepEqual(await module.notify({ summary: "x" }), {
		ok: false,
		err: start_error,
	})
	assert.deepEqual(await module.notification_name_owner(), {
		ok: false,
		err: start_error,
	})
})

test("notification calls address the bus daemon, then the owned service", async () => {
	const h = notification_harness()
	const module = await load("lib/notifications.ts", h.imports)
	h.daemon.current = Object.assign(emitter(), {
		get_actions: () => [{ id: "ags2-shell:opaque-1", label: "View" }],
	})
	assert.equal(
		(
			await module.notify({
				actions: [{ label: "View", argv: ["xdg-open", "file"] }],
			})
		).ok,
		true,
	)
	assert.deepEqual(
		h.calls.map(({ destination, path, iface, method }) => [
			destination,
			path,
			iface,
			method,
		]),
		[
			[
				"org.freedesktop.DBus",
				"/org/freedesktop/DBus",
				"org.freedesktop.DBus",
				"GetNameOwner",
			],
			[
				":1.shell",
				"/org/freedesktop/Notifications",
				"org.freedesktop.Notifications",
				"Notify",
			],
		],
	)
	assert.deepEqual(Array.from(h.calls[0].args.value), [
		"org.freedesktop.Notifications",
	])
	h.shell.emit("shutdown")
})

test("actions without a label or program are refused before Notify", async () => {
	for (const action of [
		{ label: " ", argv: ["xdg-open"] },
		{ label: "View", argv: [] },
		{ label: "View", argv: [""] },
	]) {
		const h = notification_harness()
		const module = await load("lib/notifications.ts", h.imports)
		const result = await module.notify({ actions: [action] })
		assert.equal(result.ok, false)
		assert.equal(
			result.err.message,
			"Notification actions require a label and a program",
		)
		assert.deepEqual(
			h.calls.map((call) => call.method),
			["GetNameOwner"],
		)
		assert.equal(h.daemon.listeners.size, 0)
	}
})

test("shutdown while Notify is in flight refuses to bind actions", async () => {
	const h = notification_harness()
	const module = await load("lib/notifications.ts", h.imports)
	h.daemon.current = Object.assign(emitter(), {
		get_actions: () => [{ id: "ags2-shell:opaque-1", label: "View" }],
	})
	const session = h.imports["gi://Gio"].default.DBus.session
	const call = session.call
	session.call = (...args) => {
		if (args[3] === "Notify") h.shell.emit("shutdown")
		call(...args)
	}
	const result = await module.notify({
		actions: [{ label: "View", argv: ["xdg-open", "file"] }],
	})
	assert.equal(result.ok, false)
	assert.equal(
		result.err.message,
		"Notification service shut down before actions were ready",
	)
	assert.equal(h.daemon.listeners.size, 0)
	assert.equal(
		module.notification_action_available("ags2-shell:opaque-1"),
		false,
	)
	const sent = h.calls.length
	const late = await module.notify({ summary: "late" })
	assert.equal(late.ok, false)
	assert.equal(late.err.message, "Notification service is shutting down")
	assert.equal(h.calls.length, sent)
})

test("native persistence retains capture text, not executable action bindings", async () => {
	const stored: stored_record[] = []
	const h = notification_harness(":1.shell", stored)
	const module = await load("lib/notifications.ts", h.imports)
	const pending = module.notify({
		summary: "Screenshot saved",
		body: "Saved to /home/user/Pictures/full-name.png",
		actions: [
			{
				label: "Open",
				argv: ["xdg-open", "/home/user/Pictures/full-name.png"],
			},
		],
	})
	const result = await pending
	assert.equal(result.ok, true)
	assert.equal(stored.length, 1)
	assert.equal(stored[0].transient, false)
	assert.equal(stored[0].resident, true)
	const key = stored[0].actions[0].id
	assert.match(key, /^ags2-shell:/)
	assert.equal(module.notification_action_available(key), true)
	assert.equal(module.notification_action_available("foreign-app-action"), true)
	h.daemon.current!.emit("invoked", "arbitrary-id")
	assert.equal(h.callbacks.length, 0)
	h.daemon.current!.emit("invoked", key)
	assert.deepEqual(
		h.callbacks.map((argv) => Array.from(argv)),
		[["xdg-open", "/home/user/Pictures/full-name.png"]],
	)
	assert.equal(h.daemon.current, null)
	assert.equal(module.notification_action_available(key), false)

	const capture = notification_harness(":1.shell", stored)
	const current = await load("lib/notifications.ts", capture.imports)
	assert.equal(
		(
			await current.notify({
				summary: "Recording saved",
				body: "Saved to /home/user/Videos/long-name.mp4",
				actions: [
					{
						label: "Open",
						argv: ["xdg-open", "/home/user/Videos/long-name.mp4"],
					},
				],
			})
		).ok,
		true,
	)
	const expired_key = stored[0].actions[0].id
	assert.equal(current.notification_action_available(expired_key), true)
	const restarted = notification_harness(":1.shell", stored)
	const fresh = await load("lib/notifications.ts", restarted.imports)
	assert.equal(restarted.daemon.current!.summary, "Recording saved")
	assert.equal(
		restarted.daemon.current!.body,
		"Saved to /home/user/Videos/long-name.mp4",
	)
	assert.equal(fresh.notification_action_available(expired_key), false)
	assert.equal(fresh.notification_action_available("foreign-app-action"), true)
	restarted.daemon.current!.emit("invoked", expired_key)
	assert.equal(restarted.callbacks.length, 0)
	h.shell.emit("shutdown")
	capture.shell.emit("shutdown")
	restarted.shell.emit("shutdown")
})

test("missing programs are warned about and reported in a critical notification", async (t) => {
	const h = notification_harness()
	h.imports["gi://GLib"].default.find_program_in_path = (name) =>
		name.startsWith("missing") ? null : name
	const warned: unknown[][] = []
	const errors: unknown[][] = []
	t.mock.method(console, "error", capture_log(errors))
	const module = await load("lib/notifications.ts", h.imports, {
		error: (...args) => errors.push(args),
		warn: (...args) => warned.push(args),
	})
	assert.equal(
		module.notify_missing_programs("grim", "missing-a", "missing-b"),
		false,
	)
	assert.equal(module.notify_missing_programs("grim"), true)
	assert.deepEqual(warned, [
		["notifications.dependencies: Missing missing-a, missing-b"],
	])
	for (let i = 0; i < 5; i++) await Promise.resolve()
	assert.equal(h.calls.length, 1)
	const [app_name, , app_icon, summary, body, , hints] = h.calls[0].args.value
	assert.deepEqual(
		[app_name, app_icon, summary, body, hints.urgency.value],
		[
			"Error",
			"image-missing-symbolic",
			"Missing dependencies",
			"Could not locate missing-a, missing-b",
			2,
		],
	)
	h.shell.emit("shutdown")
	assert.equal(module.notify_missing_programs("missing-b", "missing-c"), false)
	for (let i = 0; i < 5; i++) await Promise.resolve()
	assert.deepEqual(
		errors.map(([tag, error]) => [tag, (error as Error).message]),
		[
			[
				"notifications.send: Failed to send notification",
				"Notification service is shutting down",
			],
		],
	)
})

function wallpaper_harness(monitor_fails = false, initial_symlink = true) {
	const path = "/home/user/.config/background"
	const files = new Map<string, any>()
	const links = new Map<string, string>(
		initial_symlink ? [[path, "/home/user/important"]] : [],
	)
	files.set("/home/user/important", "IMPORTANT")
	if (!initial_symlink) files.set(path, "IMG existing")
	const timers: harness_timer[] = []
	const shell = emitter()
	const directory_monitor = Object.assign(emitter(), { cancel() {} })
	let revision = 0
	let release_conversion: (() => void) | null = null
	let decode_count = 0
	const faults = new Set<string>()
	class Missing extends Error {
		matches(_domain, code) {
			return code === 1
		}
	}
	const GioFile = class {
		name: string
		constructor(name: string) {
			this.name = name
		}
		get_path() {
			if (faults.has("remote-parent") && this.name === "/home/user/.config")
				return null
			return this.name
		}
		get_parent() {
			if (faults.has("no-parent") && this.name === path) return null
			return new GioFile(this.name.slice(0, this.name.lastIndexOf("/")))
		}
		query_exists() {
			return (
				this.name === "/home/user/.config" ||
				files.has(this.name) ||
				links.has(this.name)
			)
		}
		make_directory_with_parents() {
			if (faults.has("mkdir")) throw new Error("mkdir failed")
		}
		monitor_directory() {
			if (monitor_fails) throw new Error("monitor unavailable")
			return directory_monitor
		}
		query_info() {
			const content = files.get(links.get(this.name) ?? this.name)
			if (content === undefined) throw new Missing("not found")
			return {
				get_size: () =>
					content === "HUGE" && this.name.includes(".background-")
						? 64 * 1024 * 1024 + 1
						: content.length,
				get_attribute_uint64: () => revision,
				get_attribute_uint32: () => 0,
				get_attribute_string: () => "",
			}
		}
		read_async(_priority, _cancellable, callback) {
			if (faults.has("read-start")) throw new Error("read start failed")
			queueMicrotask(() => callback(this, {}))
		}
		read_finish() {
			if (faults.has("read")) throw new Error("read failed")
			return {
				name: this.name,
				close: () => {
					if (faults.has("stream-close-throws")) throw new Error("close failed")
					return !faults.has("stream-close")
				},
			}
		}
		create() {
			if (faults.has("create")) throw new Error("create failed")
			assert.equal(files.has(this.name), false)
			files.set(this.name, "")
			return {
				close: () => {
					if (faults.has("staged-close-throws"))
						throw new Error("staged close failed")
					return !faults.has("staged-close")
				},
			}
		}
		move(target) {
			if (faults.has("move")) return false
			files.set(target.name, files.get(this.name))
			links.delete(target.name)
			files.delete(this.name)
			revision++
			return true
		}
		delete() {
			if (faults.has("delete")) return false
			if (!files.delete(this.name)) throw new Missing("not found")
			return true
		}
		replace_contents(content) {
			if (faults.has("replace-throws")) throw new Error("replace failed")
			if (faults.has("replace")) return [false, ""]
			files.set(this.name, content)
			links.delete(this.name)
			revision++
			return [true, ""]
		}
	}
	const imports = {
		"$lib/app": { default: shell },
		ags: {
			createState: create_state,
		},
		"$lib/commands": {
			run_command: async (args) => {
				if (faults.has("convert"))
					return { ok: false, err: new Error("convert failed") }
				if (args[0] === "heif-dec") {
					assert.match(args.at(-1), /\.png$/)
					await new Promise<void>((resolve) => {
						release_conversion = resolve
					})
					files.set(args.at(-1), "IMG old")
				} else {
					assert.equal(args[0], "cp")
					files.set(args.at(-1), files.get(args.at(-2)))
				}
				return { ok: true, value: "" }
			},
		},
		"gi://Gio": {
			default: {
				File: { new_for_path: (name) => new GioFile(name) },
				FileCreateFlags: { PRIVATE: 1, REPLACE_DESTINATION: 2 },
				FileCopyFlags: { OVERWRITE: 1 },
				FileMonitorFlags: { NONE: 0 },
				FileQueryInfoFlags: { NONE: 0 },
				IOErrorEnum: { NOT_FOUND: 1 },
				io_error_quark: () => 1,
			},
		},
		"gi://GLib": {
			default: {
				Error: Missing,
				FileTest: { IS_SYMLINK: 1 },
				file_test: (name) => links.has(name),
				find_program_in_path: (name) =>
					faults.has(`missing ${name}`) ? null : name,
				PRIORITY_DEFAULT: 0,
				path_get_dirname: (name) => name.slice(0, name.lastIndexOf("/")),
				uuid_string_random: (() => {
					let n = 0
					return () => String(++n)
				})(),
			},
		},
		"gi://GdkPixbuf": {
			default: {
				Pixbuf: {
					get_file_info_async: (name, _cancellable, callback) => {
						if (faults.has("info-start")) throw new Error("info start failed")
						queueMicrotask(() => callback(null, { name }))
					},
					get_file_info_finish: ({ name }) => {
						if (faults.has("info")) throw new Error("info failed")
						const content = files.get(name)
						if (content === "WIDE") return [{}, 9000, 1080]
						if (content === "IMG 6000") return [{}, 6000, 6000]
						if (content === "IMG 6400") return [{}, 6400, 6400]
						return content?.startsWith("IMG") ? [{}, 1920, 1080] : [null, 0, 0]
					},
					new_from_stream_at_scale_async: (
						stream,
						width,
						_height,
						_aspect,
						_cancellable,
						callback,
					) => {
						if (faults.has("decode-start"))
							throw new Error("decode start failed")
						decode_count++
						assert.equal(width, 256)
						queueMicrotask(() => callback(null, { name: stream.name }))
					},
					new_from_stream_finish: ({ name }) => {
						if (faults.has("no-image")) return null
						if (
							!files.get(name)?.startsWith("IMG") ||
							files.get(name) === "IMG broken"
						)
							throw new Error("invalid image")
						return {}
					},
				},
			},
		},
		"$lib/env": { default: { paths: { home: "/home/user" } } },
		"$lib/time": {
			interval: capture_timer(timers),
			debounce: immediate_debounce,
		},
	}
	return {
		path,
		files,
		links,
		faults,
		timers,
		imports,
		shell,
		directory_monitor,
		external_write(name, content) {
			files.set(name, content)
			revision++
		},
		get release_conversion() {
			return release_conversion
		},
		get decode_count() {
			return decode_count
		},
	}
}

test("wallpaper validates before commit and replaces symlink entry, not target", async () => {
	const h = wallpaper_harness()
	const module = await load("lib/wallpaper.ts", await with_files(h.imports))
	assert.equal(h.timers.length, 1)
	h.files.set("/home/user/invalid", "NOT-IMAGE")
	assert.equal((await module.set_wallpaper("/home/user/invalid")).ok, false)
	assert.equal(h.links.get(h.path), "/home/user/important")
	h.files.set("/home/user/valid", "IMG new")
	assert.equal((await module.set_wallpaper("/home/user/valid")).ok, true)
	assert.equal(h.files.get(h.path), "IMG new")
	h.files.set("/home/user/texture", "TEXTURE new")
	assert.equal((await module.set_wallpaper("/home/user/texture")).ok, false)
	assert.equal(h.files.get(h.path), "IMG new")
	assert.equal(h.files.get("/home/user/important"), "IMPORTANT")
	assert.equal(h.links.has(h.path), false)
	assert.equal(h.timers[0].cancelled, true)
})

test("oversized source, staged output, and dimensions cannot replace wallpaper", async () => {
	const h = wallpaper_harness()
	const module = await load("lib/wallpaper.ts", await with_files(h.imports))
	h.files.set("/home/user/good", "IMG good")
	assert.equal((await module.set_wallpaper("/home/user/good")).ok, true)
	assert.equal(h.decode_count, 1)
	h.files.set("/home/user/too-big", { length: 64 * 1024 * 1024 + 1 })
	assert.equal((await module.set_wallpaper("/home/user/too-big")).ok, false)
	h.files.set("/home/user/large-output", "HUGE")
	assert.equal(
		(await module.set_wallpaper("/home/user/large-output")).ok,
		false,
	)
	h.files.set("/home/user/wide", "WIDE")
	assert.equal((await module.set_wallpaper("/home/user/wide")).ok, false)
	assert.equal(h.decode_count, 1)
	h.files.set("/home/user/malformed", "IMG broken")
	assert.equal((await module.set_wallpaper("/home/user/malformed")).ok, false)
	assert.equal(h.decode_count, 2)
	assert.equal(h.files.get(h.path), "IMG good")
	assert.equal(
		[...h.files.keys()].some((name) => name.includes(".background-")),
		false,
	)
})

test("the setter accepts 6000x6000 and rejects dimensions above its 40 million pixel limit", async () => {
	const h = wallpaper_harness()
	const module = await load("lib/wallpaper.ts", await with_files(h.imports))
	h.files.set("/home/user/accepted", "IMG 6000")
	assert.equal((await module.set_wallpaper("/home/user/accepted")).ok, true)
	assert.equal(h.files.get(h.path), "IMG 6000")
	h.files.set("/home/user/rejected", "IMG 6400")
	assert.equal((await module.set_wallpaper("/home/user/rejected")).ok, false)
	assert.equal(h.files.get(h.path), "IMG 6000")
})

test("clearing wallpaper invalidates a pending conversion", async () => {
	const h = wallpaper_harness()
	const module = await load("lib/wallpaper.ts", await with_files(h.imports))
	h.files.set("/home/user/old.heic", "HEIC input")
	const pending = module.set_wallpaper("/home/user/old.heic")
	for (let i = 0; i < 12 && !h.release_conversion; i++) await Promise.resolve()
	assert.equal(typeof h.release_conversion, "function")
	assert.equal(module.clear_wallpaper().ok, true)
	assert.equal(h.timers[0].cancelled, true)
	h.release_conversion!()
	assert.equal((await pending).ok, true)
	assert.equal(h.files.get(h.path), "")
	assert.equal(
		[...h.files.keys()].some((name) => name.includes(".background-")),
		false,
	)
})

async function wallpaper_failure(
	active: string[],
	name = "/home/user/next",
	content: unknown = "IMG next",
) {
	const h = wallpaper_harness(false, false)
	const errors: unknown[][] = []
	const record = (...args) => errors.push(args)
	const module = await load("lib/wallpaper.ts", await with_files(h.imports), {
		error: record,
	})
	if (content !== null) h.files.set(name, content)
	for (const fault of active) h.faults.add(fault)
	const previous = console.error
	console.error = record
	const outcome = await module.set_wallpaper(name).finally(() => {
		console.error = previous
	})
	assert.equal(outcome.ok, false)
	assert.equal(h.files.get(h.path), "IMG existing")
	return { h, error: outcome.err as Error, errors }
}

function staged_files(h: ReturnType<typeof wallpaper_harness>) {
	return [...h.files.keys()].filter((name) => name.includes(".background-"))
}

test("each wallpaper staging failure carries its reason and leaves nothing staged", async () => {
	const too_large =
		"Wallpaper must be nonempty and no larger than 67108864 bytes"
	const cases: [string[], string, string?, unknown?][] = [
		[[], "not found", "/home/user/absent", null],
		[[], too_large, "/home/user/too-big", { length: 64 * 1024 * 1024 + 1 }],
		[[], too_large, "/home/user/large-output", "HUGE"],
		[[], "Wallpaper format or dimensions are unsupported", undefined, "WIDE"],
		[["no-parent"], "Wallpaper destination has no parent directory"],
		[["remote-parent"], "Wallpaper destination is not a local directory"],
		[["mkdir"], "mkdir failed"],
		[["create"], "create failed"],
		[["staged-close"], "Failed to close temporary wallpaper"],
		[["staged-close-throws"], "staged close failed"],
		[["missing heif-dec"], "heif-dec not found", "/home/user/next.heic"],
		[["missing dwebp"], "dwebp not found", "/home/user/next.webp"],
		[["convert"], "convert failed"],
		[["info"], "info failed"],
		[["read"], "read failed"],
		[["info-start"], "info start failed"],
		[["read-start"], "read start failed"],
		[["decode-start"], "decode start failed"],
		[["no-image"], "Wallpaper decoder returned no image"],
		[["move"], "Failed to replace wallpaper"],
	]
	for (const [active, message, name, content] of cases) {
		const { h, error, errors } = await wallpaper_failure(active, name, content)
		assert.equal(error.message, message, message)
		assert.deepEqual(staged_files(h), [], message)
		assert.equal(errors.length, 0, message)
	}
})

test("a failed validation close outranks the decode error, which is logged", async () => {
	const closed = await wallpaper_failure(["stream-close"])
	assert.equal(
		closed.error.message,
		"Failed to close wallpaper validation stream",
	)
	assert.equal(closed.error.cause, undefined)
	assert.equal(closed.errors.length, 0)
	const thrown = await wallpaper_failure(["stream-close-throws", "no-image"])
	assert.equal(
		thrown.error.message,
		"Failed to close wallpaper validation stream",
	)
	assert.equal((thrown.error.cause as Error).message, "close failed")
	assert.equal(thrown.errors.length, 1)
	assert.equal(
		thrown.errors[0][0],
		"wallpaper.validate: Failed to decode wallpaper",
	)
	assert.equal(
		(thrown.errors[0][1] as Error).message,
		"Wallpaper decoder returned no image",
	)
})

test("a staged wallpaper that cannot be removed is logged after a failure", async () => {
	const { h, error, errors } = await wallpaper_failure(["move", "delete"])
	assert.equal(error.message, "Failed to replace wallpaper")
	assert.equal(staged_files(h).length, 1)
	assert.equal(errors.length, 1)
	assert.equal(
		errors[0][0],
		"wallpaper.set: Failed to remove temporary wallpaper",
	)
	assert.equal(
		(errors[0][1] as Error).message,
		"Temporary wallpaper was not removed",
	)
})

test("a superseded wallpaper that cannot be removed fails the setter", async () => {
	const h = wallpaper_harness()
	const module = await load("lib/wallpaper.ts", await with_files(h.imports))
	h.files.set("/home/user/old.heic", "HEIC input")
	const pending = module.set_wallpaper("/home/user/old.heic")
	for (let i = 0; i < 12 && !h.release_conversion; i++) await Promise.resolve()
	assert.equal(module.clear_wallpaper().ok, true)
	h.faults.add("delete")
	h.release_conversion!()
	const outcome = await pending
	assert.equal(outcome.ok, false)
	assert.equal(outcome.err.message, "Failed to remove temporary wallpaper")
	assert.equal(outcome.err.cause.message, "Temporary wallpaper was not removed")
	assert.equal(h.files.get(h.path), "")
	assert.equal(h.decode_count, 0)
})

test("a failed clear is logged and does not refresh the wallpaper", async () => {
	const cases = [
		["replace", "Failed to clear wallpaper"],
		["replace-throws", "replace failed"],
	]
	for (const [fault, message] of cases) {
		const h = wallpaper_harness(false, false)
		const module = await load("lib/wallpaper.ts", await with_files(h.imports))
		const revision = module.wallpaper_revision.peek()
		h.faults.add(fault)
		const errors: unknown[][] = []
		const previous = console.error
		console.error = (...args) => errors.push(args)
		const cleared = (() => {
			try {
				return module.clear_wallpaper()
			} finally {
				console.error = previous
			}
		})()
		assert.equal(cleared.ok, false)
		assert.equal(cleared.err.message, message)
		assert.equal(errors.length, 1)
		assert.equal(errors[0][0], "wallpaper.clear: Failed to clear wallpaper")
		assert.equal(h.files.get(h.path), "IMG existing")
		assert.equal(module.wallpaper_revision.peek(), revision)
	}
})

test("a failed directory monitor uses the fallback poll", async () => {
	const h = wallpaper_harness(true, false)
	const errors: unknown[][] = []
	await load("lib/wallpaper.ts", await with_files(h.imports), {
		error: (...args) => errors.push(args),
	})
	assert.equal(h.timers.length, 1)
	assert.equal(h.timers[0].ms, 1000)
	assert.equal(errors.length, 1)
})

test("a working monitor still polls symlink targets and stops after link replacement", async () => {
	const h = wallpaper_harness()
	const module = await load("lib/wallpaper.ts", await with_files(h.imports))
	assert.equal(h.timers.length, 1)
	const initial = module.wallpaper_revision.peek()
	h.external_write("/home/user/important", "UPDATED")
	h.timers[0].callback()
	assert.equal(module.wallpaper_revision.peek(), initial + 1)
	h.external_write(h.path, "IMG regular")
	h.links.delete(h.path)
	h.directory_monitor.emit("changed", { get_path: () => h.path }, null)
	assert.equal(module.wallpaper_revision.peek(), initial + 2)
	assert.equal(h.timers[0].cancelled, true)
	assert.equal(h.timers.length, 1)
})

test("a regular wallpaper uses only its monitor until replaced by a symlink", async () => {
	const h = wallpaper_harness(false, false)
	await load("lib/wallpaper.ts", await with_files(h.imports))
	assert.equal(h.timers.length, 0)
	h.links.set(h.path, "/home/user/important")
	h.directory_monitor.emit("changed", { get_path: () => h.path }, null)
	assert.equal(h.timers.length, 1)
	h.shell.emit("shutdown")
	assert.equal(h.timers[0].cancelled, true)
})

test("only changes naming the wallpaper refresh it and repeated stat failures log once", async () => {
	const h = wallpaper_harness(false, false)
	const errors: unknown[][] = []
	const module = await load("lib/wallpaper.ts", await with_files(h.imports), {
		error: (...args) => errors.push(args),
	})
	const initial = module.wallpaper_revision.peek()
	const other = { get_path: () => "/home/user/.config/other" }
	const wallpaper = { get_path: () => h.path }
	h.external_write(h.path, "IMG changed")
	h.directory_monitor.emit("changed", other, null)
	assert.equal(module.wallpaper_revision.peek(), initial)
	h.directory_monitor.emit("changed", other, wallpaper)
	assert.equal(module.wallpaper_revision.peek(), initial + 1)
	h.directory_monitor.emit("changed", wallpaper, null)
	assert.equal(module.wallpaper_revision.peek(), initial + 1)
	h.files.delete(h.path)
	h.directory_monitor.emit("changed", wallpaper, null)
	assert.equal(module.wallpaper_revision.peek(), initial + 2)
	const query_info = h.imports["gi://Gio"].default.File.new_for_path
	h.imports["gi://Gio"].default.File.new_for_path = (name) => {
		const file = query_info(name)
		if (name === h.path)
			file.query_info = () => {
				throw new Error("permission denied")
			}
		return file
	}
	h.directory_monitor.emit("changed", wallpaper, null)
	h.directory_monitor.emit("changed", wallpaper, null)
	assert.equal(module.wallpaper_revision.peek(), initial + 2)
	assert.deepEqual(
		errors.map(([tag, error]) => [tag, (error as Error).message]),
		[["wallpaper: Failed to inspect wallpaper", "permission denied"]],
	)
	h.imports["gi://Gio"].default.File.new_for_path = query_info
	h.external_write(h.path, "IMG back")
	h.directory_monitor.emit("changed", wallpaper, null)
	assert.equal(module.wallpaper_revision.peek(), initial + 3)
	assert.equal(h.timers.length, 0)
})
