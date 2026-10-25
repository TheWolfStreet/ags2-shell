import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"

function notification(id: number, time: number, app = "App") {
	return {
		id,
		time,
		transient: false,
		dismissed: false,
		get_app_name: () => app,
		get_desktop_entry: () => "",
		dismiss() {
			this.dismissed = true
		},
	}
}

async function fixture(stored: ReturnType<typeof notification>[]) {
	const sources: { priority: number; delay: number; run: () => boolean }[] = []
	const notified: string[] = []
	const handlers = new Map<string, () => void>()
	let blacklist = ["Muted"]
	const imports = {
		"ags/gobject": {
			default: {
				Object: class {
					notify(name: string) {
						notified.push(name)
					}
					vfunc_finalize() {}
				},
			},
			getter: () => () => {},
			register: () => (value) => value,
		},
		"$lib/time": { timeout: () => ({ cancel() {} }) },
		"gi://AstalNotifd": { default: {} },
		"gi://Gio": { default: {} },
		"gi://GLib": {
			default: {
				PRIORITY_DEFAULT: 0,
				PRIORITY_DEFAULT_IDLE: 200,
				SOURCE_REMOVE: false,
				timeout_add: (priority, delay, run) => {
					sources.push({ priority, delay, run })
					return sources.length
				},
				Source: { remove() {} },
			},
		},
		"$lib/notifications": {
			notification_daemon: {
				connect: (signal: string, callback: () => void) => {
					handlers.set(signal, callback)
					return handlers.size
				},
				disconnect() {},
				get_notifications: () => stored.filter((item) => !item.dismissed),
				get_dont_disturb: () => false,
			},
			notification_name_owner: async () => ({ ok: true, value: "" }),
		},
		"$shell/options": {
			default: {
				notifications: {
					blacklist: {
						peek: () => blacklist,
						subscribe: () => () => {},
					},
				},
			},
		},
	}
	const { notification_manager } = await load_module(
		"service/notifications.ts",
		imports,
	)
	return {
		manager: notification_manager,
		sources,
		notified,
		handlers,
		run_next() {
			const source = sources.shift()!
			assert.equal(source.run(), false)
			return source
		},
		set_blacklist(next: string[]) {
			blacklist = next
		},
	}
}

function history(count: number) {
	return Array.from({ length: count }, (_, index) =>
		notification(index, 1000 + index),
	)
}

test("pruning starts above 75 stored notifications and trims the oldest to 50 in batches", async () => {
	const stored = history(80)
	const state = await fixture(stored)
	const first = state.run_next()
	assert.deepEqual([first.priority, first.delay], [200, 250])
	assert.deepEqual(
		stored.filter((item) => item.dismissed).map((item) => item.id),
		[0, 1, 2, 3, 4, 5, 6, 7],
	)
	while (state.sources.length) state.run_next()
	assert.equal(stored.filter((item) => !item.dismissed).length, 50)
	assert.equal(
		stored.filter((item) => item.dismissed).every((item) => item.id < 30),
		true,
	)
})

test("a store at or below the trigger is left alone", async () => {
	const stored = history(75)
	const state = await fixture(stored)
	state.run_next()
	assert.equal(state.sources.length, 0)
	assert.equal(
		stored.some((item) => item.dismissed),
		false,
	)
})

test("transient notifications are never pruned or counted", async () => {
	const stored = history(80)
	for (const item of stored.slice(0, 10)) item.transient = true
	const state = await fixture(stored)
	state.run_next()
	assert.equal(
		stored.some((item) => item.dismissed),
		false,
	)
})

test("store changes coalesce into one list notification", async () => {
	const state = await fixture([])
	state.run_next()
	state.handlers.get("notified")!()
	state.handlers.get("resolved")!()
	const coalesce = state.sources.filter((source) => source.delay === 16)
	assert.equal(coalesce.length, 1)
	coalesce[0].run()
	assert.deepEqual(state.notified, ["notifications"])
})

test("the list hides blacklisted apps, sorts newest first and caps at 50", async () => {
	const stored = [
		...history(60),
		notification(100, 5000, "Muted"),
		notification(101, 4000),
	]
	const state = await fixture(stored)
	const ids = state.manager.notifications.map((item) => item.id)
	assert.equal(ids.length, 50)
	assert.deepEqual(ids.slice(0, 3), [101, 59, 58])
	assert.equal(state.manager.is_blacklisted(stored[60]), true)
	state.set_blacklist([])
	assert.equal(state.manager.notifications[0].id, 100)
})
