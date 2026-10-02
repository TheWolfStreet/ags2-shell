import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"

const source = stripTypeScriptTypes(
	readFileSync(new URL("../../shell/options.ts", import.meta.url), "utf8"),
	{ mode: "transform" },
)

async function load_options(initial, on_write) {
	let file = typeof initial === "string" ? initial : JSON.stringify(initial)
	const writes = []
	const context = createContext({ console })

	class Accessor extends Function {
		constructor(get, subscribe) {
			super("return arguments.callee.call_value()")
			this.get = get
			this.subscribe = subscribe
		}
		call_value() { return this.get() }
		peek() { return this.get() }
	}

	function createState(initial_value) {
		let value = initial_value
		const subscribers = new Set()
		return [new Accessor(() => value, (callback) => {
			subscribers.add(callback)
			return () => subscribers.delete(callback)
		}), (next) => {
			if (Object.is(value, next)) return
			value = next
			for (const subscriber of [...subscribers]) subscriber()
		}]
	}

	function attempt(fn) {
		try { return { ok: true, value: fn() } }
		catch (err) { return { ok: false, err } }
	}

	const modules = {
		ags: { Accessor, createState },
		"ags/file": {
			readFile: () => file,
			writeFileAsync: async (path, content) => {
				await on_write?.()
				file = content
				writes.push(JSON.parse(content))
			},
		},
		"ags/gtk4": { Gtk: { IconTheme: class { has_icon() { return false } } } },
		"$lib/app": { default: { iconTheme: "default" } },
		"$lib/icons": { default: { ui: { search: "search" } } },
		"$lib/env": { default: { paths: { cache: { base: "/cache" } }, distro: {} } },
		"$lib/files": { ensure_file() { return { ok: true, value: undefined } } },
		"$lib/result": {
			attempt,
			attempt_async: async (fn) => {
				try { return { ok: true, value: await fn() } }
				catch (err) { return { ok: false, err } }
			},
			err: (err) => ({ ok: false, err }),
			ok: (value) => ({ ok: true, value }),
			log_error: (result) => result.ok,
		},
		"$lib/time": { debounce: () => {
			let pending = false
			return {
				get pending() { return pending },
				call() { pending = true },
				cancel() { pending = false },
			}
		} },
	}

	const entry = new SourceTextModule(source, { context })
	await entry.link((name) => {
		const exports = modules[name]
		if (!exports) throw new Error(`Unknown module: ${name}`)
		return new SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
		}, { context })
	})
	await entry.evaluate()
	return { options: entry.namespace.default, flush: entry.namespace.flush_options, writes }
}

test("loading valid options does not write the store", async () => {
	const { options, flush, writes } = await load_options({ scale: 120, theme: { scheme: "light" } })
	assert.equal(options.scale.peek(), 120)
	assert.equal(options.theme.scheme.peek(), "light")
	assert.equal((await flush()).ok, true)
	assert.equal(writes.length, 0)
})

test("persisted font sizes and legacy launcher counts stay unchanged", async () => {
	for (const max of [0, 20]) {
		const { options, flush, writes } = await load_options({ font: "Sans 80", launcher: { apps: { max } } })
		assert.equal(options.font.peek(), "Sans 80")
		assert.equal(options.launcher.apps.max.peek(), max)
		assert.equal((await flush()).ok, true)
		assert.equal(writes.length, 0)
	}
})

test("font and launcher validation reject malformed values without imposing legacy caps", async () => {
	const { options, flush, writes } = await load_options({})
	assert.equal(options.font.set("Sans 120.5").ok, true)
	assert.equal(options.font.set('Sans"; color: red 80').ok, false)
	assert.equal(options.font.set("Sans 0").ok, false)
	for (const value of [Infinity, -1, 1.5])
		assert.equal(options.launcher.apps.max.set(value).ok, false)
	assert.equal(options.launcher.apps.max.set(20).ok, true)
	assert.equal((await flush()).ok, true)
	assert.equal(writes[0].font, "Sans 120.5")
	assert.equal(writes[0].launcher.apps.max, 20)
})

test("invalid persisted launcher count is removed while valid font is retained", async () => {
	const { options, flush, writes } = await load_options('{"font":"Sans 80","launcher":{"apps":{"max":1e400}}}')
	assert.equal(options.font.peek(), "Sans 80")
	assert.equal(options.launcher.apps.max.peek(), 6)
	assert.equal((await flush()).ok, true)
	assert.equal(writes.length, 1)
	assert.equal(writes[0].font, "Sans 80")
	assert.equal("max" in writes[0].launcher.apps, false)
})

test("launcher and color history limits retain valid bounds and reject invalid data", async () => {
	const { options, flush, writes } = await load_options({ launcher: { apps: { max: 0 } }, colorpicker: { maxColors: 100 } })
	assert.equal(options.launcher.apps.max.peek(), 0)
	assert.equal(options.colorpicker.maxColors.peek(), 100)
	assert.equal(options.colorpicker.maxColors.set(128).ok, true)
	assert.equal(options.colorpicker.maxColors.set(129).ok, false)
	assert.equal(options.launcher.apps.max.set(-1).ok, false)
	assert.equal(options.launcher.apps.max.set(Infinity).ok, false)
	assert.equal(options.notifications.blacklist.set(new Uint8Array([1, 2])).ok, false)
	assert.equal((await flush()).ok, true)
	assert.equal(writes[0].launcher.apps.max, 0)
	assert.equal(writes[0].colorpicker.maxColors, 128)
})

test("negative persisted launcher counts are rejected without changing valid neighbors", async () => {
	const { options, flush, writes } = await load_options({ launcher: { apps: { max: -2 } }, font: "Sans 80" })
	assert.equal(options.launcher.apps.max.peek(), 6)
	assert.equal(options.font.peek(), "Sans 80")
	assert.equal((await flush()).ok, true)
	assert.equal(writes.length, 1)
	assert.equal("max" in writes[0].launcher.apps, false)
	assert.equal(writes[0].font, "Sans 80")
})

test("invalid persisted values are removed without replacing valid neighbors", async () => {
	const { options, flush, writes } = await load_options('{"scale":1e400,"theme":{"scheme":"unknown","dark":{"bg":"red"},"widget":{"opacity":72}},"notifications":{"blacklist":[null,1]}}')
	assert.equal(options.scale.peek(), 100)
	assert.equal(options.theme.scheme.peek(), "dark")
	assert.equal(options.theme.dark.bg.peek(), "#171717")
	assert.equal(options.theme.widget.opacity.peek(), 72)
	assert.equal((await flush()).ok, true)
	assert.equal(writes.length, 1)
	assert.equal("scale" in writes[0], false)
	assert.equal("scheme" in writes[0].theme, false)
	assert.equal("bg" in writes[0].theme.dark, false)
	assert.equal("blacklist" in writes[0].notifications, false)
})

test("set validates enums, numbers, colors, and string arrays before publishing", async () => {
	const { options, flush, writes } = await load_options({})
	assert.equal(options.theme.scheme.set("invalid").ok, false)
	assert.equal(options.scale.set(Infinity).ok, false)
	assert.equal(options.scale.set(-5).ok, false)
	assert.equal(options.bar.workspaces.count.set(3.5).ok, false)
	assert.equal(options.theme.opacity.set(101).ok, false)
	assert.equal(options.theme.dark.bg.set("red; color: blue").ok, false)
	assert.equal(options.notifications.blacklist.set([null]).ok, false)
	assert.equal(options.bar.workspaces.count.set(0).ok, true)
	const blacklist = ["Music"]
	assert.equal(options.notifications.blacklist.set(blacklist).ok, true)
	blacklist.push("Unexpected")
	assert.deepEqual([...options.notifications.blacklist.peek()], ["Music"])
	assert.equal(Object.isFrozen(options.notifications.blacklist.peek()), true)
	assert.equal(options.scale.peek(), 100)
	assert.equal((await flush()).ok, true)
	assert.equal(writes.length, 1)
	assert.deepEqual(writes[0].notifications.blacklist, ["Music"])
	assert.equal(writes[0].bar.workspaces.count, 0)
})

test("array defaults compare by contents and remain immutable", async () => {
	const { options, flush, writes } = await load_options({})
	const opt = options.notifications.blacklist
	assert.equal(opt.set(["Other"]).ok, true)
	assert.equal(opt.set([...opt.get_default()]).ok, true)
	assert.equal(opt.peek(), opt.get_default())
	assert.equal(Object.isFrozen(opt.peek()), true)
	assert.equal((await flush()).ok, true)
	assert.equal("notifications" in writes[0] && "blacklist" in writes[0].notifications, false)
})

test("stored arrays equal to defaults do not appear changed or get rewritten", async () => {
	const { options, flush, writes } = await load_options({
		notifications: { blacklist: ["Spotify", "com.spotify.Client"] },
	})
	assert.equal(options.notifications.blacklist.peek(), options.notifications.blacklist.get_default())
	assert.equal((await flush()).ok, true)
	assert.equal(writes.length, 0)
})

test("reentrant subscribers cannot overwrite newer persisted values", async () => {
	const { options, flush, writes } = await load_options({})
	options.scale.subscribe(() => {
		if (options.scale.peek() === 180) options.scale.set(150)
	})
	assert.equal(options.scale.set(180).ok, true)
	assert.equal(options.scale.peek(), 150)
	assert.equal((await flush()).ok, true)
	assert.equal(writes[0].scale, 150)
	assert.equal(options.scale.reset().ok, true)
	assert.equal((await flush()).ok, true)
	assert.equal("scale" in writes[1], false)
})

test("flush waits for queued writes and saves the latest state last", async () => {
	let release_first
	let started = 0
	const { options, flush, writes } = await load_options({}, () => {
		started++
		if (started === 1) return new Promise((resolve) => { release_first = resolve })
	})
	options.scale.set(120)
	const first = flush()
	await new Promise((resolve) => setImmediate(resolve))
	options.scale.set(140)
	const second = flush()
	assert.equal(started, 1)
	release_first()
	assert.equal((await first).ok, true)
	assert.equal((await second).ok, true)
	assert.equal(started, 2)
	assert.deepEqual(writes.map((value) => value.scale), [120, 140])
})

test("a failed save reports its reason and a later edit retries", async () => {
	let attempts = 0
	const { options, flush, writes } = await load_options({}, () => {
		if (++attempts === 1) throw new Error("disk full")
	})
	options.scale.set(120)
	const failed = await flush()
	assert.equal(failed.ok, false)
	assert.match(failed.err.message, /disk full/)
	options.scale.set(140)
	assert.equal((await flush()).ok, true)
	assert.equal(writes[0].scale, 140)
})

test("an explicit flush retries a failed write without another edit", async () => {
	let attempts = 0
	const { options, flush, writes } = await load_options({}, () => {
		if (++attempts === 1) throw new Error("disk full")
	})
	options.scale.set(120)
	assert.equal((await flush()).ok, false)
	assert.equal((await flush()).ok, true)
	assert.equal(attempts, 2)
	assert.equal(writes[0].scale, 120)
})
