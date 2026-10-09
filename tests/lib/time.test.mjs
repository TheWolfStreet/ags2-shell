import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { test } from "node:test"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"

async function load() {
	const sources = new Map()
	let next = 1
	const add = (_priority, delay, callback) => {
		if (!callback) callback = delay
		const id = next++
		sources.set(id, callback)
		return id
	}
	const glib = {
		PRIORITY_DEFAULT: 0,
		PRIORITY_DEFAULT_IDLE: 0,
		SOURCE_REMOVE: false,
		SOURCE_CONTINUE: true,
		timeout_add: add,
		idle_add: add,
		Source: { remove: (id) => assert.ok(sources.delete(id)) },
	}
	const context = createContext({ console, Promise })
	const source = stripTypeScriptTypes(
		readFileSync(new URL("../../lib/time.ts", import.meta.url), "utf8"),
	)
	const module = new SourceTextModule(source, { context })
	await module.link(
		() =>
			new SyntheticModule(
				["default"],
				function () {
					this.setExport("default", glib)
				},
				{ context },
			),
	)
	await module.evaluate()
	return {
		module: module.namespace,
		sources,
		tick(id) {
			const callback = sources.get(id)
			assert.ok(callback)
			if (!callback()) sources.delete(id)
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
	const calls = []
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
