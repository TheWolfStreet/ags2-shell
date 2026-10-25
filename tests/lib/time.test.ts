import assert from "node:assert/strict"
import { test } from "node:test"
import { load_module } from "../load_module.ts"

async function load() {
	const sources = new Map<number, () => boolean>()
	const added: string[] = []
	const removed: number[] = []
	let next = 1
	const add = (kind: string, priority: number, callback, ms?: number) => {
		const id = next++
		sources.set(id, callback)
		added.push(`${id}:${kind}:${priority}${ms === undefined ? "" : `:${ms}`}`)
		return id
	}
	const glib = {
		PRIORITY_DEFAULT: 0,
		PRIORITY_DEFAULT_IDLE: 200,
		SOURCE_REMOVE: false,
		SOURCE_CONTINUE: true,
		timeout_add: (priority, ms, callback) =>
			add("timeout", priority, callback, ms),
		idle_add: (priority, callback) => add("idle", priority, callback),
		Source: {
			remove: (id) => {
				removed.push(id)
				assert.ok(sources.delete(id))
			},
		},
	}
	const module = await load_module("lib/time.ts", {
		"gi://GLib": { default: glib },
	})
	return {
		module,
		sources,
		added,
		removed,
		tick(id) {
			const callback = sources.get(id)
			assert.ok(callback)
			const keep = callback()
			if (!keep) sources.delete(id)
			return keep
		},
	}
}

test("canceling an interval removes both immediate and repeating sources", async () => {
	const { module, sources } = await load()
	let calls = 0
	const timer = module.interval(100, () => calls++)
	assert.equal(sources.size, 2)
	timer.cancel()
	timer.cancel()
	assert.equal(sources.size, 0)
	assert.equal(calls, 0)
})

test("interval cancellation after its first tick removes the live source", async () => {
	const { module, sources, tick } = await load()
	let calls = 0
	const timer = module.interval(100, () => calls++)
	tick(2)
	tick(1)
	assert.equal(calls, 2)
	timer.cancel()
	assert.equal(sources.size, 0)
})

test("completed one-shots can be canceled without removing stale source IDs", async () => {
	const { module, sources, tick } = await load()
	let calls = 0
	const timer = module.timeout(100, () => calls++)
	tick(1)
	timer.cancel()
	assert.equal(calls, 1)
	assert.equal(sources.size, 0)
})

test("debounce runs only the latest request and flush cancels delayed work", async () => {
	const { module, sources, tick } = await load()
	const calls: number[] = []
	const delayed = module.debounce(100, (value) => {
		calls.push(value)
	})
	delayed.call(1)
	delayed.call(2)
	assert.equal(sources.size, 1)
	tick(2)
	assert.equal(delayed.pending, false)
	assert.deepEqual(calls, [2])
	delayed.call(3)
	delayed.flush(4)
	assert.equal(sources.size, 0)
	assert.deepEqual(calls, [2, 4])
})

test("one-shots pick idle or timeout sources and intervals add an immediate idle", async () => {
	const { module, added, removed, tick } = await load()
	module.timeout(0, () => {})
	module.idle(() => {})
	module.timeout(-5, () => {})
	module.timeout(30, () => {})
	const repeating = module.interval(100, () => {})
	module.interval(0, () => {})
	assert.deepEqual(added, [
		"1:idle:200",
		"2:idle:200",
		"3:timeout:0:1",
		"4:timeout:0:30",
		"5:timeout:0:100",
		"6:idle:200",
		"7:timeout:0:1",
		"8:idle:200",
	])
	assert.equal(tick(5), true)
	assert.equal(tick(6), false)
	repeating.cancel()
	assert.deepEqual(removed, [5])
	assert.equal(tick(4), false)
})

test("an interval canceled inside its callback stops repeating and skips its first run", async () => {
	const { module, sources, removed, tick } = await load()
	let calls = 0
	const timer = module.interval(100, () => {
		calls++
		timer.cancel()
	})
	assert.equal(tick(1), false)
	assert.deepEqual(removed, [1, 2])
	assert.equal(calls, 1)
	assert.equal(sources.size, 0)
})

test("failing callbacks and rejected promises are logged and keep the timer alive", async (t) => {
	const { module, tick } = await load()
	const logged: unknown[][] = []
	t.mock.method(console, "error", (...args) => {
		if (!String(args[0]).includes("ExperimentalWarning")) logged.push(args)
	})
	const thrown = new Error("thrown")
	const rejected = new Error("rejected")
	module.interval(10, () => {
		throw thrown
	})
	module.timeout(10, () => Promise.reject(rejected))
	module.timeout(10, () => Promise.resolve(1))
	assert.equal(tick(1), true)
	assert.equal(tick(3), false)
	assert.equal(tick(4), false)
	assert.deepEqual(logged, [["timer: Callback failed", thrown]])
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(logged, [
		["timer: Callback failed", thrown],
		["timer: Callback failed", rejected],
	])
})

test("clock text pads minutes only when hours are shown", async () => {
	const { module } = await load()
	assert.equal(module.format_clock(0), "0:00")
	assert.equal(module.format_clock(65.9), "1:05")
	assert.equal(module.format_clock(3600), "1:00:00")
	assert.equal(module.format_clock(3725), "1:02:05")
})
