import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { test } from "node:test"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"

const results = {
	ok: value => ({ ok: true, value }), err: err => ({ ok: false, err }),
	attempt: fn => { try { return { ok: true, value: fn() } } catch (err) { return { ok: false, err } } },
	attempt_async: async fn => { try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, err } } },
}

async function load(file, imports) {
	const context = createContext({ console })
	const source = stripTypeScriptTypes(readFileSync(new URL(file, new URL("../../lib/", import.meta.url)), "utf8"))
	const module = new SourceTextModule(source, { context })
	await module.link(name => {
		const exports = imports[name]
		assert.ok(exports, name)
		return new SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
		}, { context })
	})
	await module.evaluate()
	return module.namespace
}

class NativeError extends Error {
	constructor(code) { super(String(code)); this.code = code }
	matches(domain, code) { return code === this.code }
}

test("ensure operations verify existing entry types and close created streams", async () => {
	let type = 2
	let closed = 0
	let exists = true
	let close_error = false
	const file = {
		make_directory_with_parents() { if (exists) throw new NativeError(1) },
		query_info: () => ({ get_file_type: () => type }),
		get_parent: () => ({ get_path: () => "/parent" }),
		create() {
			if (exists) throw new NativeError(1)
			return { close() { closed++; if (close_error) throw new NativeError(2); return true } }
		},
	}
	const module = await load("./files.ts", {
		"gi://Gio": { default: {
			File: { new_for_path: () => file }, FileType: { DIRECTORY: 2, REGULAR: 3 },
			FileQueryInfoFlags: { NONE: 0 }, FileCreateFlags: { PRIVATE: 1 },
			io_error_quark: () => 0, IOErrorEnum: { EXISTS: 1 },
		} },
		"gi://GLib": { default: { Error: NativeError } }, "$lib/result": results,
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
	const commands = []
	let response = "ok"
	const module = await load("./apps.ts", {
		"gi://AstalApps": { default: {} },
		"gi://GioUnix": { default: { DesktopAppInfo: { new: () => null } } },
		"gi://GLib": { default: { shell_quote: value => `'${value.replaceAll("'", "'\\''")}'` } },
		"$lib/hyprland": { hyprland: { message_async: async command => { commands.push(command); return response } } },
		"$lib/result": results,
	})
	assert.equal((await module.launch_program(["program", "file with space", "quote'"])).ok, true)
	assert.equal(commands[0], "dispatch exec 'program' 'file with space' 'quote'\\'''" )
	response = "Invalid dispatcher"
	assert.equal((await module.launch_program(["program"])).ok, false)
	assert.equal((await module.launch_program([])).ok, false)
	assert.equal(commands.length, 2)
	assert.equal((await module.launch_app({ get_entry: () => "missing.desktop", launch: () => false })).ok, false)
})

test("icon substitutions never return inherited object members", async () => {
	const module = await load("./icons.ts", {})
	for (const name of ["constructor", "toString", "__proto__"])
		assert.equal(module.substitute_icon_name(name), name)
	assert.equal(module.substitute_icon_name(""), "image-missing-symbolic")
})
