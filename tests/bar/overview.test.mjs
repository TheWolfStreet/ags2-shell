import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")

async function overview_fixture() {
	const requests = []
	const timers = []
	let toggle
	let cleanup
	let refreshes = 0
	const hyprland = {
		clients: [],
		sync_clients: callback => { requests.push(callback) },
		sync_clients_finish: result => { if (result.error) throw result.error },
	}
	const imports = {
		ags: {
			createBinding: () => () => [], createComputed: fn => fn, For: () => null,
			onCleanup: fn => { cleanup = fn }, onMount: () => {},
		},
		"$lib/time": { idle: () => ({ cancel() {} }), timeout: (_ms, callback) => {
			const timer = { callback, cancelled: false, cancel() { this.cancelled = true } }
			timers.push(timer)
			return timer
		} },
		"$lib/app": { default: { get_window: () => null } },
		"ags/gtk4": { Astal: { Layer: { OVERLAY: 1 } }, Gdk: { DragAction: { MOVE: 1 } },
			Gtk: { Align: { CENTER: 1, FILL: 2 } } },
		"ags/gtk4/jsx-runtime": { jsx: () => null, jsxs: () => null },
		"ags/gobject": { default: {} },
		"gi://AstalHyprland": { default: {} },
		"widget/shared/PopupWindow": { PopupWindow: () => null },
		"../PanelButton": { PanelButton: () => null },
		"$lib/hyprland": { hyprland },
		"$lib/windowing": {
			create_client_title_accessor: () => null, create_workspace_clients: () => [],
			focused_window_client: {}, move_client_to_workspace_silent: () => {},
			on_window_toggle: (_name, callback) => { toggle = callback; return () => {} },
			read_client_placement_version: () => 0, refresh_client_placement: () => { refreshes++ },
			subscribe_client_placement: () => () => {},
		},
		"$shell/options": { default: { overview: { workspaces: () => 1 } } },
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
	module.namespace.Overview.Window()
	return {
		requests, timers, hyprland, toggle: visible => toggle({ visible }),
		finish: index => requests[index](null, {}),
		fire: index => { timers[index].cancelled = true; timers[index].callback() },
		refreshes: () => refreshes, cleanup: () => cleanup(),
	}
}

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
