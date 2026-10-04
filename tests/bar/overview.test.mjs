import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")

async function overview_fixture(client = null) {
	const requests = []
	const timers = []
	let toggle
	let cleanup
	let refreshes = 0
	const accessor = get => Object.assign(() => get(), {
		peek: get, as: fn => accessor(() => fn(get())),
	})
	const make = (type, props = {}) => {
		if (typeof type === "function") return type(props)
		return { type, props, children: (Array.isArray(props.children) ? props.children : [props.children]).filter(Boolean) }
	}
	const hyprland = {
		clients: [],
		sync_clients: callback => { requests.push(callback) },
		sync_clients_finish: result => { if (result.error) throw result.error },
	}
	const imports = {
		ags: {
			createBinding: (object, property) => accessor(() => object[property]),
			createComputed: fn => accessor(fn),
			For: ({ each, children }) => each().map(children),
			onCleanup: fn => { cleanup = fn }, onMount: () => {},
		},
		"$lib/time": { idle: () => ({ cancel() {} }), timeout: (_ms, callback) => {
			const timer = { callback, cancelled: false, cancel() { this.cancelled = true } }
			timers.push(timer)
			return timer
		} },
		"$lib/app": { default: { get_window: () => null } },
		"ags/gtk4": { Astal: { Layer: { OVERLAY: 1 } }, Gdk: {
			DragAction: { MOVE: 1 }, BUTTON_MIDDLE: 2,
			ContentProvider: { new_for_value: value => value },
			ContentFormats: { new_for_gtype: value => value },
		}, Gtk: { Align: { CENTER: 1, FILL: 2 }, GestureClick: "gesture-click",
			DragSource: "drag-source", Fixed: "fixed" } },
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"ags/gobject": { default: { TYPE_STRING: 1 } },
		"widget/shared/PopupWindow": { PopupWindow: props => make("popup-window", props) },
		"../PanelButton": { PanelButton: () => null },
		"$lib/hyprland": { hyprland },
		"$lib/windowing": {
			create_client_title_accessor: () => null,
			create_workspace_clients: () => accessor(() => client ? [client] : []),
			focused_window_client: accessor(() => null), move_client_to_workspace_silent: () => {},
			on_window_toggle: (_name, callback) => { toggle = callback; return () => {} },
			read_client_placement_version: () => 0, refresh_client_placement: () => { refreshes++ },
			subscribe_client_placement: () => () => {},
		},
		"$shell/options": { default: { overview: { workspaces: () => 1, scale: accessor(() => 100) },
			scale: accessor(() => 100) } },
	}
	const source = readFileSync(new URL("../../widget/Bar/components/Overview/index.tsx", import.meta.url), "utf8")
	const compiled = ts.transpileModule(source, { compilerOptions: {
		module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
		jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "ags/gtk4",
	} }).outputText
	const module = new SourceTextModule(compiled)
	await module.link(name => {
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name])) this.setExport(key, value)
		})
	})
	await module.evaluate()
	const root = module.namespace.Overview.Window()
	return {
		root,
		requests, timers, hyprland, toggle: visible => toggle({ visible }),
		finish: index => requests[index](null, {}),
		fire: index => { timers[index].cancelled = true; timers[index].callback() },
		refreshes: () => refreshes, cleanup: () => cleanup(),
	}
}

test("overview client middle click kills and resets without focusing; primary click and drag remain", async () => {
	let focused = 0
	let killed = 0
	let resets = 0
	const client = {
		address: "0x1", get_address: () => "0x1", get_width: () => 800, get_height: () => 600,
		get_class: () => "example", get_workspace: () => ({ id: 1 }),
		focus: () => { focused++ }, kill: () => { killed++ },
	}
	const fixture = await overview_fixture(client)
	const nodes = node => Array.isArray(node) ? node.flatMap(nodes) :
		[node, ...node.children.flatMap(nodes)]
	const button = nodes(fixture.root).find(node => node.type === "button" &&
		node.children.some(child => child.type === "drag-source"))
	assert.ok(button)
	const gesture = button.children.find(child => child.type === "gesture-click")
	assert.ok(gesture)
	assert.equal(gesture.props.button, 2)
	assert.equal(button.children.find(child => child.type === "drag-source").props.content, "0x1")
	gesture.props.onPressed({ reset: () => { resets++ } })
	assert.equal(killed, 1)
	assert.equal(resets, 1)
	assert.equal(focused, 0)
	button.props.onClicked()
	assert.equal(focused, 1)
	assert.equal(killed, 1)
	fixture.cleanup()
})

for (const order of ["completion first", "timer first"]) {
	test(`reopen retains one sync and refreshes after stale ${order}`, async () => {
		const fixture = await overview_fixture()
		fixture.toggle(true)
		assert.equal(fixture.requests.length, 1)
		fixture.toggle(false)
		fixture.toggle(true)
		assert.equal(fixture.timers.length, 1)
		if (order === "timer first") fixture.fire(0)
		fixture.hyprland.clients = [{ address: "new", workspace: { id: 1 }, x: 1, y: 1, width: 10, height: 10 }]
		fixture.finish(0)
		assert.equal(fixture.refreshes(), 0)
		assert.equal(fixture.requests.length, 1)
		if (order === "completion first") fixture.fire(0)
		else fixture.fire(1)
		assert.equal(fixture.requests.length, 2)
		fixture.finish(1)
		assert.equal(fixture.refreshes(), 1)
		assert.equal(fixture.timers.filter(timer => !timer.cancelled).length, 1)
		fixture.toggle(false)
		fixture.cleanup()
	})
}

test("closed overview ignores stale completion and canceled timer", async () => {
	const fixture = await overview_fixture()
	fixture.toggle(true)
	fixture.toggle(false)
	fixture.toggle(true)
	fixture.toggle(false)
	fixture.fire(0)
	fixture.finish(0)
	assert.equal(fixture.requests.length, 1)
	assert.equal(fixture.refreshes(), 0)
	assert.equal(fixture.timers.filter(timer => !timer.cancelled).length, 0)
	fixture.toggle(true)
	assert.equal(fixture.requests.length, 2)
	fixture.cleanup()
})
