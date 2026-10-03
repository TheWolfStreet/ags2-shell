import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")
const tick = () => new Promise(resolve => setImmediate(resolve))
const devices = keymap => ({ keyboards: [
	{ name: "auxiliary", main: false, active_keymap: "Russian" },
	{ name: "main", main: true, active_keymap: keymap },
] })

async function keyboard_fixture() {
	const requests = []
	const handlers = new Map()
	const cleanups = []
	const labels = []
	const errors = []
	let serial = 0
	const accessor = get => Object.assign(() => get(), { peek: get, as: fn => accessor(() => fn(get())) })
	const make = (type, props = {}) => {
		if (typeof type === "function") return type(props)
		const node = { type, props }
		if (type === "label") labels.push(node)
		return node
	}
	const imports = {
		ags: {
			createState: initial => {
				let value = initial
				return [accessor(() => value), next => { value = next }]
			},
			createBinding: (object, property) => accessor(() => object[property]),
			createComputed: fn => accessor(fn), For: () => null,
			onCleanup: fn => cleanups.push(fn),
		},
		"ags/file": { monitorFile: () => { throw new Error("Unexpected file monitor") } },
		"ags/gtk4": {
			Astal: { Exclusivity: { EXCLUSIVE: 1 } }, Gdk: { BUTTON_MIDDLE: 2 },
			Gtk: { Align: { CENTER: 1 }, Orientation: { VERTICAL: 1 },
				EventControllerScrollFlags: { VERTICAL: 1 }, ContentFit: { COVER: 1 },
				EventControllerScroll: "scroll", GestureClick: "gesture" },
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"ags/process": { execAsync: args => {
			assert.deepEqual(Array.from(args), ["hyprctl", "devices", "-j"])
			return new Promise((resolve, reject) => requests.push({ resolve, reject }))
		} },
		"gi://AstalMpris": { default: { get_default: () => ({}) } },
		"gi://AstalWp": { default: { get_default: () => null } },
		"$lib/app": { default: {} },
		"widget/Settings": { Settings: {} },
		"widget/Bar/components/PanelButton": { PanelButton: props => make("panel", props) },
		"widget/shared/PopupWindow": { create_popup_position: () => ({}), PopupWindow: () => null },
		"./components/Network": { Network: { State: () => null } },
		"./components/Audio": { Audio: { State: { Speaker: () => null, Microphone: () => null } } },
		"./components/MenuControls": { ToggleButton: () => null },
		"./components/Bluetooth": { Bluetooth: { State: () => null } },
		"./components/DisplayMirroring": { DisplayMirroring: {} },
		"./components/MediaPlayer": { MediaPlayer: () => null },
		"./components/PowerProfiles": { PowerProfiles: { State: { Power: () => null, Asus: () => null } } },
		"$lib/env": { default: {} },
		"$lib/icons": { default: { notifications: { silent: "silent" } }, get_brightness_icon: () => "" },
		"$lib/textures": { texture_from_file_square_contain: () => null },
		"$lib/hyprland": { hyprland: {
			connect: (signal, callback) => {
				assert.equal(signal, "keyboard-layout")
				handlers.set(++serial, callback)
				return serial
			},
			disconnect: id => assert.equal(handlers.delete(id), true),
		} },
		"$lib/notifications": { notification_daemon: { dontDisturb: false } },
		"$service/brightness": { brightness: {} },
		"$shell/options": { default: { bar: {}, quicksettings: {}, theme: { scheme: {} } }, ui_scale: () => 1 },
	}
	const context = createContext({ console: { error: (...args) => errors.push(args) } })
	const compile = source => ts.transpileModule(source, { compilerOptions: {
		module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
		jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "ags/gtk4",
	} }).outputText
	const result = new SourceTextModule(compile(readFileSync(new URL("../../lib/result.ts", import.meta.url), "utf8")), { context })
	await result.link(() => { throw new Error("Unexpected result import") })
	const source = readFileSync(new URL("../../widget/Bar/components/QuickSettings/index.tsx", import.meta.url), "utf8")
	const module = new SourceTextModule(compile(source), { context })
	await module.link(name => {
		if (name === "$lib/result") return result
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name])) this.setExport(key, value)
		}, { context })
	})
	await module.evaluate()
	return {
		requests, handlers, errors,
		mount: () => { module.namespace.QuickSettings.Button(); return labels.at(-1).props.label },
		unmount: () => cleanups.shift()(),
		emit: (keyboard, layout) => { for (const callback of handlers.values()) callback(null, keyboard, layout) },
		complete: async (index, data) => { requests[index].resolve(JSON.stringify(data)); await tick() },
	}
}

test("layout events re-query the main keyboard instead of displaying event error or none", async () => {
	const f = await keyboard_fixture()
	const label = f.mount()
	await f.complete(0, devices("English (US)"))
	assert.equal(label(), "en")
	for (const [index, payload, keymap, code] of [
		[1, "error", "Russian", "ru"], [2, "none", "Hebrew", "he"], [3, "English (US)", "English (US)", "en"],
	]) {
		f.emit("main", payload)
		assert.equal(f.requests.length, index + 1)
		await f.complete(index, devices(keymap))
		assert.equal(label(), code)
	}
	f.emit("auxiliary", "Russian")
	await f.complete(4, devices("English (US)"))
	assert.equal(label(), "en")
	assert.equal(f.errors.length, 0)
})

test("invalid device layouts and failed reads retain the last good label and report failure", async () => {
	const f = await keyboard_fixture()
	const label = f.mount()
	await f.complete(0, devices("English (US)"))
	const invalid = [devices("error"), devices("none"), devices(" Error "), devices(" NONE "),
		devices("  "), devices(""), devices(undefined), devices(123),
		{ keyboards: [] }, { keyboards: [null] }, null]
	for (const [index, data] of invalid.entries()) {
		f.emit("main", "error")
		await f.complete(index + 1, data)
		assert.equal(label(), "en")
		assert.equal(f.errors.length, index + 1)
	}
	f.emit("main", "none")
	f.requests.at(-1).resolve("not JSON")
	await tick()
	assert.equal(label(), "en")
	f.emit("main", "none")
	f.requests.at(-1).reject(new Error("hyprctl unavailable"))
	await tick()
	assert.equal(label(), "en")
	assert.equal(f.errors.length, invalid.length + 2)
	f.emit("replacement-keyboard", "error")
	await f.complete(f.requests.length - 1, devices("Hebrew"))
	assert.equal(label(), "he")
})

test("startup failure recovers when a keyboard appears", async () => {
	const f = await keyboard_fixture()
	const label = f.mount()
	await f.complete(0, { keyboards: [] })
	assert.equal(label(), "")
	assert.equal(f.errors.length, 1)
	f.emit("new-keyboard", "none")
	await f.complete(1, devices("Russian"))
	assert.equal(label(), "ru")
})

test("only the latest layout query updates shared monitor labels", async () => {
	const f = await keyboard_fixture()
	const first = f.mount()
	const second = f.mount()
	assert.equal(f.requests.length, 1)
	assert.equal(f.handlers.size, 1)
	f.emit("main", "Russian")
	f.emit("main", "Hebrew")
	await f.complete(2, devices("Hebrew"))
	await f.complete(1, devices("Russian"))
	await f.complete(0, devices("English (US)"))
	assert.equal(first(), "he")
	assert.equal(second(), "he")
	f.unmount()
	assert.equal(f.handlers.size, 1)
	f.emit("main", "English (US)")
	await f.complete(3, devices("English (US)"))
	assert.equal(second(), "en")
	f.unmount()
	assert.equal(f.handlers.size, 0)
})

test("unmount invalidates pending queries even after remount", async () => {
	const f = await keyboard_fixture()
	f.mount()
	f.unmount()
	const label = f.mount()
	await f.complete(1, devices("Russian"))
	await f.complete(0, devices("English (US)"))
	assert.equal(label(), "ru")
})

test("latest failure retains the prior layout and obsolete failures do not log", async () => {
	const f = await keyboard_fixture()
	const label = f.mount()
	await f.complete(0, devices("English (US)"))
	f.emit("main", "Russian")
	f.emit("main", "Hebrew")
	f.requests[2].reject(new Error("latest read failed"))
	await tick()
	await f.complete(1, devices("Russian"))
	assert.equal(label(), "en")
	assert.equal(f.errors.length, 1)
	f.emit("main", "Russian")
	f.emit("main", "Hebrew")
	await f.complete(4, devices("Hebrew"))
	f.requests[3].reject(new Error("obsolete read failed"))
	await tick()
	assert.equal(label(), "he")
	assert.equal(f.errors.length, 1)
	f.emit("main", "English (US)")
	f.unmount()
	f.requests[5].reject(new Error("unmounted read failed"))
	await tick()
	assert.equal(label(), "he")
	assert.equal(f.errors.length, 1)
})
