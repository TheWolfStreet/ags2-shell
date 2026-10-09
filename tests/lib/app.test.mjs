import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { test } from "node:test"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"

async function shell_app() {
	const events = []
	const context = createContext({ console })
	const source = stripTypeScriptTypes(
		readFileSync(new URL("../../lib/app.ts", import.meta.url), "utf8").replace(
			/^@register\(\)\n/m,
			"",
		),
	)
	const module = new SourceTextModule(source, { context })
	class BaseApp {
		listeners = []
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
		disconnect(listener) {
			this.listeners.splice(this.listeners.indexOf(listener), 1)
		}
		quit(code) {
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
						quit() {
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
	await module.link(
		(name) =>
			new SyntheticModule(
				Object.keys(imports[name]),
				function () {
					for (const [key, value] of Object.entries(imports[name]))
						this.setExport(key, value)
				},
				{ context },
			),
	)
	await module.evaluate()
	return { app: module.namespace.default, events }
}

test("constructor-bound DBus quit awaits flush and recorder before native shutdown and exit", async () => {
	const { app, events } = await shell_app()
	let release
	app.before_quit = async () => {
		events.push("flush")
		await new Promise((resolve) => {
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
