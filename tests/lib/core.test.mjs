import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { test } from "node:test"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"

async function load(file, imports, logger = console) {
	const context = createContext({ console: logger })
	const source = stripTypeScriptTypes(readFileSync(new URL(file, new URL("../../lib/", import.meta.url)), "utf8"))
	const module = new SourceTextModule(source, { context })
	await module.link((name) => {
		const exports = imports[name]
		assert.ok(exports, `Unexpected import: ${name}`)
		return new SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
		}, { context })
	})
	await module.evaluate()
	return module.namespace
}

function emitter() {
	let next = 1
	const listeners = new Map()
	return {
		listeners,
		connect(event, callback) {
			const id = next++
			listeners.set(id, { event, callback })
			return id
		},
		disconnect(id) { assert.ok(listeners.delete(id)) },
		emit(event, ...args) {
			for (const listener of [...listeners.values()])
				if (listener.event === event) listener.callback(this, ...args)
		},
	}
}

function notificationHarness(owner = ":1.shell") {
	const shell = emitter()
	const daemon = Object.assign(emitter(), {
		current: null,
		get_notification() { return this.current },
	})
	const callbacks = []
	const calls = []
	const timers = []
	const session = {
		get_unique_name: () => ":1.shell",
		call(destination, path, iface, method, args, reply, flags, ms, cancellable, callback) {
			calls.push({ destination, method, args })
			queueMicrotask(() => callback({ call_finish: () => ({
				recursiveUnpack: () => method === "GetNameOwner" ? [owner] : [7],
			}) }, {}))
		},
	}
	const imports = {
		"ags/process": { execAsync: (args) => { callbacks.push(args); return Promise.resolve("") } },
		"$lib/app": { default: shell },
		"$lib/time": { timeout: (ms, callback) => {
			const timer = { ms, callback, cancelled: false, cancel() { this.cancelled = true } }
			timers.push(timer)
			return timer
		} },
		"gi://AstalNotifd": { default: { get_default: () => daemon } },
		"gi://Gio": { default: { DBus: { session }, DBusCallFlags: { NONE: 0 } } },
		"gi://GLib": { default: {
			find_program_in_path: name => name,
			Variant: class { constructor(type, value) { this.value = value } },
			VariantType: class {},
			uuid_string_random: (() => { let n = 0; return () => `opaque-${++n}` })(),
		} },
		"$lib/icons": { default: { missing: "missing" } },
		"$lib/result": { attempt_async: async (fn) => {
			try { return { ok: true, value: await fn() } }
			catch (error) { return { ok: false, err: error } }
		}, attempt: (fn) => {
			try { return { ok: true, value: fn() } }
			catch (error) { return { ok: false, err: error } }
		} },
	}
	return { shell, daemon, calls, callbacks, timers, imports }
}

test("notification actions execute only bound argument arrays, then detach on replacement", async () => {
	const h = notificationHarness()
	const module = await load("./notifications.ts", h.imports)
	const notification = Object.assign(emitter(), {
		get_actions: () => [{ id: "opaque-1", label: "View" }],
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
		if (args[3] === "Notify") notification.resident = args[4].value[6].resident?.value === true
		old_call(...args)
	}
	const result = await module.notify({ actions: [{ label: "View", argv: ["xdg-open", "file with space"] }] })
	assert.equal(result.ok, true)
	assert.equal(h.calls[1].destination, ":1.shell")
	assert.equal(h.calls[1].args.value[6].transient.value, true)
	assert.equal(h.calls[1].args.value[6].resident.value, true)
	notification.emit("invoked", "arbitrary executable")
	assert.equal(h.callbacks.length, 0)
	assert.equal(notification.dismiss_count, 0)
	notification.emit("invoked", "opaque-1")
	assert.deepEqual(h.callbacks.map((argv) => Array.from(argv)), [["xdg-open", "file with space"]])
	assert.equal(notification.dismiss_count, 1)
	assert.equal(h.daemon.listeners.size, 0)
	assert.equal(notification.listeners.size, 1)
	notification.emit("invoked", "opaque-1")
	assert.equal(h.callbacks.length, 1)
})

test("notification replacement detaches bound action handler", async () => {
	const h = notificationHarness()
	const module = await load("./notifications.ts", h.imports)
	const notification = Object.assign(emitter(), {
		get_actions: () => [{ id: "opaque-1", label: "View" }],
	})
	h.daemon.current = notification
	assert.equal((await module.notify({ actions: [{ label: "View", argv: ["xdg-open", "file"] }] })).ok, true)
	h.daemon.current = Object.assign(emitter(), { get_actions: () => [] })
	h.daemon.emit("notified", 7, true)
	assert.equal(h.daemon.listeners.size, 0)
	assert.equal(notification.listeners.size, 0)
	notification.emit("invoked", "opaque-1")
	assert.equal(h.callbacks.length, 0)
})

test("competing daemon cannot receive executable actions or leave listeners", async () => {
	const h = notificationHarness(":1.other")
	const module = await load("./notifications.ts", h.imports)
	const result = await module.notify({ actions: [{ label: "View", argv: ["xdg-open", "file"] }] })
	assert.equal(result.ok, false)
	assert.deepEqual(h.calls.map((call) => call.method), ["GetNameOwner"])
	assert.equal(h.daemon.listeners.size, 0)
})

test("replaced notification with different action keys is refused", async () => {
	const h = notificationHarness()
	const module = await load("./notifications.ts", h.imports)
	h.daemon.current = Object.assign(emitter(), {
		get_actions: () => [{ id: "other", label: "View" }],
	})
	const result = await module.notify({ actions: [{ label: "View", argv: ["xdg-open", "file"] }] })
	assert.equal(result.ok, false)
	assert.equal(h.daemon.listeners.size, 0)
	h.daemon.current.emit("invoked", "other")
	assert.equal(h.callbacks.length, 0)
})

test("pending notification attachment expires and disconnects", async () => {
	const h = notificationHarness()
	const module = await load("./notifications.ts", h.imports)
	const pending = module.notify({ actions: [{ label: "View", argv: ["xdg-open", "file"] }] })
	for (let i = 0; i < 4; i++) await Promise.resolve()
	assert.equal(h.daemon.listeners.size, 2)
	h.timers[0].callback()
	const result = await pending
	assert.equal(result.ok, false)
	assert.equal(h.daemon.listeners.size, 0)
})

test("shutdown detaches active notification actions", async () => {
	const h = notificationHarness()
	const module = await load("./notifications.ts", h.imports)
	h.daemon.current = Object.assign(emitter(), {
		get_actions: () => [{ id: "opaque-1", label: "View" }],
	})
	assert.equal((await module.notify({ actions: [{ label: "View", argv: ["xdg-open", "file"] }] })).ok, true)
	h.shell.emit("shutdown")
	assert.equal(h.daemon.listeners.size, 0)
	assert.equal(h.daemon.current.listeners.size, 0)
	assert.equal((await module.notify({ summary: "late" })).ok, false)
})

function wallpaperHarness(monitor_fails = false) {
	const path = "/home/user/.config/background"
	const files = new Map()
	const links = new Map([[path, "/home/user/important"]])
	files.set("/home/user/important", "IMPORTANT")
	const timers = []
	const shell = emitter()
	let revision = 0
	let release_conversion = null
	let decode_count = 0
	class Missing extends Error {
		matches(domain, code) { return code === 1 }
	}
	const GioFile = class {
		constructor(name) { this.name = name }
		get_path() { return this.name }
		get_parent() { return new GioFile(this.name.slice(0, this.name.lastIndexOf("/"))) }
		query_exists() { return this.name === "/home/user/.config" || files.has(this.name) || links.has(this.name) }
		make_directory_with_parents() {}
		monitor_directory() { if (monitor_fails) throw new Error("monitor unavailable"); return Object.assign(emitter(), { cancel() {} }) }
		query_info() {
			const content = files.get(links.get(this.name) ?? this.name)
			if (content === undefined) throw new Missing("not found")
			return {
				get_size: () => content === "HUGE" && this.name.includes(".background-")
					? 64 * 1024 * 1024 + 1 : content.length,
				get_attribute_uint64: () => revision,
				get_attribute_uint32: () => 0,
				get_attribute_string: () => "",
			}
		}
		read_async(priority, cancellable, callback) { queueMicrotask(() => callback(this, {})) }
		read_finish() { return { name: this.name, close: () => true } }
		create() {
			assert.equal(files.has(this.name), false)
			files.set(this.name, "")
			return { close: () => true }
		}
		move(target) {
			files.set(target.name, files.get(this.name))
			links.delete(target.name)
			files.delete(this.name)
			revision++
			return true
		}
		delete() { if (!files.delete(this.name)) throw new Missing("not found"); return true }
		replace_contents(content) { files.set(this.name, content); links.delete(this.name); revision++; return [true, ""] }
	}
	const imports = {
		"$lib/app": { default: shell },
		"ags": { createState: (initial) => {
			let value = initial
			return [{ peek: () => value, subscribe: () => () => {} }, (fn) => { value = fn(value) }]
		} },
		"ags/process": { execAsync: async (args) => {
			if (args[0] === "heif-dec") {
				assert.match(args.at(-1), /\.png$/)
				await new Promise((resolve) => { release_conversion = resolve })
				files.set(args.at(-1), "IMG old")
			} else {
				assert.equal(args[0], "cp")
				files.set(args.at(-1), files.get(args.at(-2)))
			}
		} },
		"gi://Gio": { default: {
			File: { new_for_path: (name) => new GioFile(name) },
			FileCreateFlags: { PRIVATE: 1, REPLACE_DESTINATION: 2 },
			FileCopyFlags: { OVERWRITE: 1 },
			FileMonitorFlags: { NONE: 0 },
			FileQueryInfoFlags: { NONE: 0 },
			IOErrorEnum: { NOT_FOUND: 1 },
			io_error_quark: () => 1,
		} },
		"gi://GLib": { default: {
			Error: Missing,
			find_program_in_path: name => name,
			PRIORITY_DEFAULT: 0,
			path_get_dirname: (name) => name.slice(0, name.lastIndexOf("/")),
			uuid_string_random: (() => { let n = 0; return () => String(++n) })(),
		} },
		"gi://GdkPixbuf": { default: {
			Pixbuf: {
				get_file_info_async: (name, cancellable, callback) => queueMicrotask(() => callback(null, { name })),
				get_file_info_finish: ({ name }) => {
					const content = files.get(name)
					if (content === "WIDE") return [{}, 9000, 1080]
					return content?.startsWith("IMG") ? [{}, 1920, 1080] : [null, 0, 0]
				},
				new_from_stream_at_scale_async: (stream, width, height, aspect, cancellable, callback) => {
					decode_count++
					assert.equal(width, 256)
					queueMicrotask(() => callback(null, { name: stream.name }))
				},
				new_from_stream_finish: ({ name }) => {
					if (!files.get(name)?.startsWith("IMG") || files.get(name) === "IMG broken")
						throw new Error("invalid image")
					return {}
				},
			},
		} },
		"$lib/env": { default: { paths: { home: "/home/user" } } },
		"$lib/result": {
			attempt: (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { ok: false, err: error } } },
			attempt_async: async (fn) => { try { return { ok: true, value: await fn() } } catch (error) { return { ok: false, err: error } } },
			err: (reason) => ({ ok: false, err: reason }),
			ok: (value) => ({ ok: true, value }),
		},
		"$lib/time": {
			interval: (ms, fn) => { timers.push({ ms, fn }); return { cancel() {} } },
			debounce: (ms, fn) => ({ call: fn, cancel() {} }),
		},
	}
	return { path, files, links, timers, imports,
		get release_conversion() { return release_conversion },
		get decode_count() { return decode_count },
	}
}

test("wallpaper validates before commit and replaces symlink entry, not target", async () => {
	const h = wallpaperHarness()
	const module = await load("./wallpaper.ts", h.imports)
	assert.equal(h.timers.length, 0)
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
})

test("oversized source, staged output, and dimensions cannot replace wallpaper", async () => {
	const h = wallpaperHarness()
	const module = await load("./wallpaper.ts", h.imports)
	h.files.set("/home/user/good", "IMG good")
	assert.equal((await module.set_wallpaper("/home/user/good")).ok, true)
	assert.equal(h.decode_count, 1)
	h.files.set("/home/user/too-big", { length: 64 * 1024 * 1024 + 1 })
	assert.equal((await module.set_wallpaper("/home/user/too-big")).ok, false)
	h.files.set("/home/user/large-output", "HUGE")
	assert.equal((await module.set_wallpaper("/home/user/large-output")).ok, false)
	h.files.set("/home/user/wide", "WIDE")
	assert.equal((await module.set_wallpaper("/home/user/wide")).ok, false)
	assert.equal(h.decode_count, 1)
	h.files.set("/home/user/malformed", "IMG broken")
	assert.equal((await module.set_wallpaper("/home/user/malformed")).ok, false)
	assert.equal(h.decode_count, 2)
	assert.equal(h.files.get(h.path), "IMG good")
	assert.equal([...h.files.keys()].some((name) => name.includes(".background-")), false)
})

test("clearing wallpaper invalidates a pending conversion", async () => {
	const h = wallpaperHarness()
	const module = await load("./wallpaper.ts", h.imports)
	h.files.set("/home/user/old.heic", "HEIC input")
	const pending = module.set_wallpaper("/home/user/old.heic")
	for (let i = 0; i < 12 && !h.release_conversion; i++) await Promise.resolve()
	assert.equal(typeof h.release_conversion, "function")
	assert.equal(module.clear_wallpaper().ok, true)
	h.release_conversion()
	assert.equal((await pending).ok, true)
	assert.equal(h.files.get(h.path), "")
	assert.equal([...h.files.keys()].some((name) => name.includes(".background-")), false)
})

test("a failed directory monitor uses the fallback poll", async () => {
	const h = wallpaperHarness(true)
	const errors = []
	await load("./wallpaper.ts", h.imports, { error: (...args) => errors.push(args) })
	assert.equal(h.timers.length, 1)
	assert.equal(h.timers[0].ms, 1000)
	assert.equal(errors.length, 1)
})
