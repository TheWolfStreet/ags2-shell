import assert from "node:assert/strict"
import { test } from "node:test"
import { load_module } from "../load_module.ts"

type shutdown_listener = { callback: () => void; after: boolean }

async function shell_app() {
	const events: string[] = []
	class BaseApp {
		listeners: shutdown_listener[] = []
		dbus_quit: (code?: number) => void
		constructor() {
			this.dbus_quit = this.quit.bind(this)
		}
		connect_after(signal, callback) {
			assert.equal(signal, "shutdown")
			const listener = { callback, after: true }
			this.listeners.push(listener)
			return listener
		}
		connect(signal, callback) {
			assert.equal(signal, "shutdown")
			const listener = { callback, after: false }
			this.listeners.push(listener)
			return listener
		}
		disconnect(listener: shutdown_listener) {
			this.listeners.splice(this.listeners.indexOf(listener), 1)
		}
		quit(code?: number) {
			events.push(`exit:${code}`)
		}
	}
	const upstream = new BaseApp()
	const imports = {
		"./native": {},
		"ags/gtk4/app": { default: upstream },
		"ags/gtk4": {
			Gtk: {
				Application: {
					prototype: {
						quit(this: BaseApp) {
							events.push("native-quit")
							queueMicrotask(() => {
								for (const listener of [...this.listeners].filter(
									(item) => !item.after,
								))
									listener.callback()
								for (const listener of [...this.listeners].filter(
									(item) => item.after,
								))
									listener.callback()
							})
						},
					},
				},
			},
		},
		"ags/gobject": { default: { Object: class {} }, register: () => () => {} },
	}
	const module = await load_module("lib/app.ts", imports)
	return { app: module.default, events }
}

test("constructor-bound DBus quit awaits flush and recorder before native shutdown and exit", async () => {
	const { app, events } = await shell_app()
	let release = () => {}
	app.before_quit = async () => {
		events.push("flush")
		await new Promise<void>((resolve) => {
			release = resolve
		})
		events.push("recorder")
		return true
	}
	app.connect("shutdown", () => events.push("cleanup"))
	app.dbus_quit(7)
	app.quit(8)
	await Promise.resolve()
	assert.deepEqual(events, ["flush"])
	release()
	for (let i = 0; i < 5; i++) await Promise.resolve()
	assert.deepEqual(events, [
		"flush",
		"recorder",
		"native-quit",
		"cleanup",
		"exit:7",
	])
})

test("failed guard does not shut down and allows a later DBus quit", async () => {
	const { app, events } = await shell_app()
	let allowed = false
	app.before_quit = async () => {
		events.push("flush")
		return allowed
	}
	app.dbus_quit()
	for (let i = 0; i < 5; i++) await Promise.resolve()
	assert.deepEqual(events, ["flush"])
	allowed = true
	app.dbus_quit()
	for (let i = 0; i < 5; i++) await Promise.resolve()
	assert.deepEqual(events, ["flush", "flush", "native-quit", "exit:0"])
})

test("a throwing guard is logged, leaves no shutdown hook and allows a later quit", async (t) => {
	const { app, events } = await shell_app()
	const logged: unknown[][] = []
	t.mock.method(console, "error", (...args: unknown[]) => {
		if (!String(args[0]).includes("ExperimentalWarning")) logged.push(args)
	})
	const failure = new Error("guard broke")
	app.before_quit = async () => {
		events.push("flush")
		throw failure
	}
	app.quit(3)
	for (let i = 0; i < 5; i++) await Promise.resolve()
	assert.deepEqual(logged, [
		["shell.quit: Failed to quit application", failure],
	])
	assert.equal(app.listeners.length, 0)
	app.before_quit = undefined
	app.quit(4)
	for (let i = 0; i < 5; i++) await Promise.resolve()
	assert.deepEqual(events, ["flush", "native-quit", "exit:4"])
})
