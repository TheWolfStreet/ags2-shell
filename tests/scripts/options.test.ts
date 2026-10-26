import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { createContext } from "node:vm"
import * as result from "../../lib/result.ts"
import { load_module } from "../load_module.ts"
import { tick, subscribe_set } from "../helpers.ts"

const logged: unknown[][] = []

test.beforeEach(() => {
	logged.length = 0
	mock.method(console, "error", (...args: unknown[]) => logged.push(args))
})

test.afterEach(() => mock.restoreAll())

async function load_options(
	initial,
	on_write?: () => unknown,
	{ move_fails = false, ensure_fails = false } = {},
) {
	let file = typeof initial === "string" ? initial : JSON.stringify(initial)
	const writes: any[] = []
	const moves: string[][] = []
	const context = createContext({ console })

	class Accessor extends Function {
		declare get: () => unknown
		declare subscribe: (callback: () => void) => () => boolean
		constructor(get, subscribe) {
			super("return arguments.callee.call_value()")
			this.get = get
			this.subscribe = subscribe
		}
		call_value() {
			return this.get()
		}
		peek() {
			return this.get()
		}
	}

	function createState(initial_value) {
		let value = initial_value
		const subscribers = new Set<() => void>()
		return [
			new Accessor(() => value, subscribe_set(subscribers)),
			(next) => {
				if (Object.is(value, next)) return
				value = next
				for (const subscriber of [...subscribers]) subscriber()
			},
		]
	}

	const modules = {
		ags: { Accessor, createState },
		"ags/file": {
			readFile: () => file,
			writeFileAsync: async (_path, content) => {
				await on_write?.()
				file = content
				writes.push(JSON.parse(content))
			},
		},
		"gi://Gio": {
			default: {
				File: {
					new_for_path: (path: string) => ({
						path,
						move(target: { path: string }) {
							if (move_fails) throw new Error("move failed")
							moves.push([path, target.path])
							file = ""
							return true
						},
					}),
				},
				FileCopyFlags: { OVERWRITE: 1 },
			},
		},
		"ags/gtk4": {
			Gtk: {
				IconTheme: class {
					has_icon() {
						return false
					}
				},
			},
		},
		"$lib/app": { default: { iconTheme: "default" } },
		"$lib/icons": { default: { ui: { search: "search" } } },
		"$lib/env": {
			default: { paths: { cache: { base: "/cache" } }, distro: {} },
		},
		"$lib/files": {
			ensure_file() {
				if (ensure_fails) return result.err(new Error("read-only cache"))
				return result.ok(undefined)
			},
		},
		"$lib/time": {
			debounce: () => {
				let pending = false
				return {
					get pending() {
						return pending
					},
					call() {
						pending = true
					},
					cancel() {
						pending = false
					},
				}
			},
		},
	}

	const namespace = await load_module("shell/options.ts", modules, context)
	return {
		options: namespace.default,
		ui_scale: namespace.ui_scale as () => number,
		collect_options: namespace.collect_options,
		subscribe_options: namespace.subscribe_options,
		surface_scale: namespace.surface_scale,
		flush: namespace.flush_options as () => Promise<{
			ok: boolean
			err?: any
		}>,
		writes,
		moves,
	}
}

test("loading valid options does not write the store", async () => {
	const { options, flush, writes } = await load_options({
		scale: 120,
		theme: { scheme: "light" },
	})
	assert.equal(options.scale.peek(), 120)
	assert.equal(options.theme.scheme.peek(), "light")
	assert.equal((await flush()).ok, true)
	assert.equal(writes.length, 0)
})

test("an unreadable store is set aside before anything is written", async () => {
	for (const initial of ["{broken", "[1, 2]"]) {
		const { options, flush, writes, moves } = await load_options(initial)
		assert.deepEqual(moves, [
			["/cache/options.json", "/cache/options.json.bad"],
		])
		assert.equal(options.scale.set(130).ok, true)
		assert.equal((await flush()).ok, true)
		assert.deepEqual(writes, [{ scale: 130 }])
	}
})

test("an unreadable store that cannot be set aside is never overwritten", async () => {
	const { options, flush, writes, moves } = await load_options(
		"{broken",
		undefined,
		{
			move_fails: true,
		},
	)
	assert.deepEqual(moves, [])
	assert.equal(options.scale.set(130).ok, true)
	assert.equal((await flush()).ok, false)
	assert.deepEqual(writes, [])
})

test("persisted font sizes and legacy launcher counts stay unchanged", async () => {
	for (const max of [0, 20]) {
		const { options, flush, writes } = await load_options({
			font: "Sans 80",
			launcher: { apps: { max } },
		})
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
	const { options, flush, writes } = await load_options(
		'{"font":"Sans 80","launcher":{"apps":{"max":1e400}}}',
	)
	assert.equal(options.font.peek(), "Sans 80")
	assert.equal(options.launcher.apps.max.peek(), 6)
	assert.equal((await flush()).ok, true)
	assert.equal(writes.length, 1)
	assert.equal(writes[0].font, "Sans 80")
	assert.equal("max" in writes[0].launcher.apps, false)
})

test("launcher and color history limits retain valid bounds and reject invalid data", async () => {
	const { options, flush, writes } = await load_options({
		launcher: { apps: { max: 0 } },
		colorpicker: { maxColors: 100 },
	})
	assert.equal(options.launcher.apps.max.peek(), 0)
	assert.equal(options.colorpicker.maxColors.peek(), 100)
	assert.equal(options.colorpicker.maxColors.set(128).ok, true)
	assert.equal(options.colorpicker.maxColors.set(129).ok, false)
	assert.equal(options.launcher.apps.max.set(-1).ok, false)
	assert.equal(options.launcher.apps.max.set(Infinity).ok, false)
	assert.equal(
		options.notifications.blacklist.set(new Uint8Array([1, 2])).ok,
		false,
	)
	assert.equal((await flush()).ok, true)
	assert.equal(writes[0].launcher.apps.max, 0)
	assert.equal(writes[0].colorpicker.maxColors, 128)
})

test("negative persisted launcher counts are rejected without changing valid neighbors", async () => {
	const { options, flush, writes } = await load_options({
		launcher: { apps: { max: -2 } },
		font: "Sans 80",
	})
	assert.equal(options.launcher.apps.max.peek(), 6)
	assert.equal(options.font.peek(), "Sans 80")
	assert.equal((await flush()).ok, true)
	assert.equal(writes.length, 1)
	assert.equal("max" in writes[0].launcher.apps, false)
	assert.equal(writes[0].font, "Sans 80")
})

test("invalid persisted values are removed without replacing valid neighbors", async () => {
	const { options, flush, writes } = await load_options(
		'{"scale":1e400,"theme":{"scheme":"unknown","dark":{"bg":"red"},"widget":{"opacity":72}},"notifications":{"blacklist":[null,1]}}',
	)
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
	assert.equal(options.theme.transparency.set(71).ok, false)
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
	assert.equal(
		"notifications" in writes[0] && "blacklist" in writes[0].notifications,
		false,
	)
})

test("stored arrays equal to defaults do not appear changed or get rewritten", async () => {
	const { options, flush, writes } = await load_options({
		notifications: { blacklist: ["Spotify", "com.spotify.Client"] },
	})
	assert.equal(
		options.notifications.blacklist.peek(),
		options.notifications.blacklist.get_default(),
	)
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
		if (started === 1)
			return new Promise((resolve) => {
				release_first = resolve
			})
	})
	options.scale.set(120)
	const first = flush()
	await tick()
	options.scale.set(140)
	const second = flush()
	assert.equal(started, 1)
	release_first()
	assert.equal((await first).ok, true)
	assert.equal((await second).ok, true)
	assert.equal(started, 2)
	assert.deepEqual(
		writes.map((value) => value.scale),
		[120, 140],
	)
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

test("each option names the editor its default and rule imply", async () => {
	const { options } = await load_options({})
	assert.equal(options.theme.scheme.editor(), "enum")
	assert.equal(options.font.editor(), "font")
	assert.equal(options.theme.dark.bg.editor(), "color")
	assert.equal(options.hyprland.inactiveBorder.editor(), "color")
	assert.equal(options.theme.blur.editor(), "boolean")
	assert.equal(options.scale.editor(), "number")
	assert.equal(options.bar.date.format.editor(), "string")
	assert.equal(options.bar.launcher.icon.editor(), "icon")
	assert.equal(options.bar.launcher.icon.set("folder").ok, true)
	assert.equal(options.bar.launcher.icon.set("bad\nname").ok, false)
	assert.equal(options.theme.dark.bg.set("#12345g").ok, false)
	assert.equal(options.font.set("Sans").ok, false)
})

function log_heads() {
	return logged.map((entry) => {
		const [tag, error] = entry
		if (entry.length > 1) return [tag, (error as Error).constructor.name]
		return [tag]
	})
}

test("store recovery logs why the store was unreadable and where it went", async () => {
	await load_options("{broken")
	assert.deepEqual(log_heads(), [
		["option.store.load: Failed to load options store", "SyntaxError"],
		["option.store.load: Unreadable options moved to /cache/options.json.bad"],
	])
	logged.length = 0
	await load_options("[1, 2]")
	assert.deepEqual(log_heads(), [
		["option.store.load: Options store does not contain an object"],
		["option.store.load: Unreadable options moved to /cache/options.json.bad"],
	])
	logged.length = 0
	await load_options("{broken", undefined, { move_fails: true })
	assert.deepEqual(log_heads(), [
		["option.store.load: Failed to load options store", "SyntaxError"],
		["option.store.load: Failed to set aside unreadable options", "Error"],
	])
})

test("an unpreparable store loads defaults and reports every failed save", async () => {
	const { options, flush, writes } = await load_options(
		{ scale: 150 },
		undefined,
		{ ensure_fails: true },
	)
	assert.equal(options.scale.peek(), 100)
	assert.deepEqual(log_heads(), [
		["option.store.load: Failed to prepare options store", "Error"],
	])
	logged.length = 0
	options.scale.set(120)
	const saved = await flush()
	assert.equal(saved.ok, false)
	assert.equal(saved.err.message, "read-only cache")
	assert.deepEqual(writes, [])
	assert.deepEqual(log_heads(), [
		["option.store.save: Failed to save options store", "Error"],
	])
})

test("rejected values are logged with the option id", async () => {
	const { options } = await load_options({})
	const rejected = options.theme.scheme.set("sepia")
	assert.equal(rejected.err.message, "Invalid value for option theme.scheme")
	assert.deepEqual(log_heads(), [["option.set: Rejected value", "Error"]])
})

test("scale helpers turn percentages into factors", async () => {
	const { options, ui_scale, surface_scale } = await load_options({
		scale: 150,
	})
	assert.equal(ui_scale(), 1.5)
	options.scale.set(50)
	assert.equal(ui_scale(), 0.5)
	assert.equal(surface_scale(options.dock.scale), 1)
	options.dock.scale.set(200)
	assert.equal(surface_scale(options.dock.scale), 2)
})

test("options are collected by id and subscriptions follow prefixes", async () => {
	const { options, collect_options, subscribe_options } = await load_options({})
	const ids = collect_options(options).map((opt) => opt.id)
	assert.equal(new Set(ids).size, ids.length)
	assert.ok(ids.includes("theme.dark.primary.bg"))
	assert.ok(ids.includes("asus.bat_hz"))
	assert.deepEqual(
		[...collect_options(options.theme.border).map((opt) => opt.id)],
		["theme.border.width", "theme.border.opacity"],
	)
	let calls = 0
	const dispose = subscribe_options(options, ["theme.border", "scale"], () => {
		calls++
	})
	options.theme.border.width.set(3)
	options.scale.set(120)
	options.theme.padding.set(4)
	assert.equal(calls, 2)
	dispose()
	options.scale.set(130)
	assert.equal(calls, 2)
})
