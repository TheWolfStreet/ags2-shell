import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc = realpathSync(
	execFileSync("which", ["tsc"], { encoding: "utf8" }).trim(),
)
const ts = createRequire(tsc)(
	"../lib/node_modules/typescript/lib/typescript.js",
)
const path = "/mock/Desktop/keep"
const missing = "/mock/Desktop/missing"
const file = { name: "keep", path }
const metrics = (columns) => ({
	rows: 8,
	columns,
	cellWidth: 100,
	cellHeight: 100,
	offsetX: 0,
	offsetY: 0,
	paddingRight: 0,
	paddingBottom: 0,
})

function compile(name, tsx = false) {
	const source = readFileSync(
		new URL(`../../widget/Desktop/${name}`, import.meta.url),
		"utf8",
	)
	return new SourceTextModule(
		ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2022,
				...(tsx
					? { jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "ags/gtk4" }
					: {}),
			},
		}).outputText,
	)
}

async function fixture() {
	const saved = JSON.stringify({
		placements: {
			[path]: { monitor: "monitor:screen", slot: 17 },
			[missing]: { monitor: "monitor:screen", slot: 19 },
		},
		columns: { "monitor:screen": 4 },
	})
	let disk = saved
	let writes = 0
	let saves = 0
	let changed
	const scans = []
	const shutdown = []
	const state = (initial) => {
		let value = initial
		const subscribers = new Set()
		const get = Object.assign(() => value, {
			peek: () => value,
			subscribe: (fn) => {
				subscribers.add(fn)
				return () => subscribers.delete(fn)
			},
		})
		return [
			get,
			(next) => {
				value = next
				for (const fn of [...subscribers]) fn()
			},
		]
	}
	const computed = (fn) =>
		Object.assign(() => fn(), { peek: fn, subscribe: () => () => {} })
	const monitor = {
		get_geometry: () => ({ x: 0, y: 0, width: 400, height: 900 }),
		get_connector: () => "screen",
	}
	const hypr_monitors = computed(() => [{ name: "screen" }])
	const hyprland = {
		monitors: hypr_monitors,
		connect: () => 1,
		disconnect: () => {},
	}
	const fixed = (value) => () => value
	const options = {
		theme: { padding: fixed(0), spacing: fixed(0) },
		font: fixed("11"),
		bar: { position: fixed("top") },
		taskbar: { location: fixed("none") },
		dock: { mode: fixed("none") },
		desktop: { iconSize: fixed("small"), enabled: true },
	}
	const app = {
		connect: (_name, fn) => shutdown.push(fn),
		get_monitors: () => [monitor],
	}
	const imports = {
		"$lib/app": { default: app },
		ags: {
			createState: state,
			createComputed: computed,
			createBinding: (object, property) =>
				property === "monitors"
					? object.monitors
					: computed(() => object.get_geometry()),
			onCleanup: () => {},
		},
		"ags/file": { readFile: () => disk },
		"ags/gtk4": {
			Gdk: { Display: { get_default: () => null } },
			Gtk: {},
			Astal: {
				Layer: { BOTTOM: 0 },
				Exclusivity: { IGNORE: 0 },
				Keymode: { ON_DEMAND: 0 },
				WindowAnchor: { TOP: 1, BOTTOM: 2, LEFT: 4, RIGHT: 8 },
			},
		},
		"ags/gtk4/jsx-runtime": {
			jsx: (type, props) => ({ type, props }),
			jsxs: (type, props) => ({ type, props }),
		},
		"gi://Gio": {
			default: {
				File: {
					new_for_path: () => ({
						query_exists: () => true,
						monitor_directory: () => ({
							connect: (_event, fn) => {
								changed = fn
							},
							cancel: () => {},
						}),
					}),
				},
				FileMonitorFlags: { WATCH_MOVES: 1 },
			},
		},
		"gi://GLib": {
			default: {
				FileTest: { EXISTS: 1 },
				file_test: () => true,
				file_set_contents: (_name, value) => {
					disk = value
					writes++
					return true
				},
			},
		},
		"$lib/env": { default: { paths: { cache: { base: "/mock/cache" } } } },
		"$lib/result": {
			attempt: (fn) => {
				try {
					return { ok: true, value: fn() }
				} catch (err) {
					return { ok: false, err }
				}
			},
			unwrap_or: (result, fallback) => (result.ok ? result.value : fallback),
			log_error: (result) => result.ok,
		},
		"$lib/time": {
			idle: (fn) => fn(),
			debounce: (delay, fn) => ({
				call: () => {
					if (delay === 500) saves++
					else void fn()
				},
				cancel: () => {},
				flush: () => fn(),
				get pending() {
					return delay === 500 && saves > writes
				},
			}),
		},
		"./FileOperations": {
			DESKTOP_PATH: "/mock/Desktop",
			load_desktop_files: () => new Promise((resolve) => scans.push(resolve)),
			...Object.fromEntries(
				[
					"clear_clipboard_file_payload",
					"create_desktop_folder",
					"create_desktop_launcher",
					"create_desktop_text_file",
					"open_path",
					"permanently_delete_files",
					"read_clipboard_file_payload",
					"rename_file",
					"trash_files",
					"transfer_desktop_files",
					"write_clipboard_file_payload",
				].map((name) => [
					name,
					() => {
						throw new Error(`unexpected ${name}`)
					},
				]),
			),
		},
		"./components/Grid": {
			attach_desktop_keyboard: () => {},
			DesktopGrid: () => null,
		},
		"./components/ContextMenu": { DesktopContextMenu: () => null },
		"./DragAndDrop": { create_desktop_drag_controller: () => ({}) },
		"$lib/windowing": { schedule_monitor_window_release: () => {} },
		"$lib/hyprland": { hyprland },
		"$shell/options": {
			default: options,
			surface_scale: fixed(1),
			ui_scale: fixed(1),
		},
	}
	const geometry = compile("GridGeometry.ts")
	const desktop = compile("Desktop.ts")
	const index = compile("index.tsx", true)
	const modules = { "./GridGeometry": geometry, "./Desktop": desktop }
	const mocks = new Map()
	const link = (name) => {
		if (modules[name]) return modules[name]
		assert.ok(imports[name], `missing mock: ${name}`)
		if (!mocks.has(name))
			mocks.set(
				name,
				new SyntheticModule(Object.keys(imports[name]), function () {
					for (const [key, value] of Object.entries(imports[name]))
						this.setExport(key, value)
				}),
			)
		return mocks.get(name)
	}
	await index.link(link)
	await index.evaluate()
	return {
		window: () => index.namespace.Desktop.Window({ gdkmonitor: monitor }),
		grid: () => desktop.namespace.get_desktop_grid("monitor:screen"),
		layout: () => JSON.parse(disk),
		saves: () => saves,
		flush: () => shutdown[0](),
		resize: (next) =>
			desktop.namespace.resize_desktop_grid("monitor:screen", metrics(next)),
		refresh: () => changed(),
		scan: async (result, index = 0) => {
			assert.ok(scans[index], `scan ${index} not requested`)
			scans[index](result.ok === false ? result : { ok: true, value: result })
			await new Promise(setImmediate)
		},
	}
}

test("window before initial scan does not reset saved slots or save an empty layout", async () => {
	const f = await fixture()
	f.window()
	assert.equal(f.saves(), 0)
	assert.equal(f.grid().positions[path], 17)
	await f.scan([file])
	assert.equal(f.grid().positions[path], 17)
	f.flush()
	assert.equal(f.layout().placements[path].slot, 17)
	assert.equal(f.layout().placements[missing], undefined)
})

test("load before window preserves positions and a confirmed empty scan prunes paths", async () => {
	const f = await fixture()
	await f.scan([file])
	f.window()
	assert.equal(f.grid().positions[path], 17)
	f.refresh()
	await f.scan([], 1)
	f.flush()
	assert.deepEqual(f.layout().placements, {})
})

test("rejected initial scan retains layout until a successful retry", async () => {
	const f = await fixture()
	f.window()
	await f.scan({ ok: false, err: new Error("directory unavailable") })
	assert.equal(f.saves(), 0)
	assert.equal(f.grid().positions[path], 17)
	f.refresh()
	await f.scan([file], 1)
	f.flush()
	assert.equal(f.layout().placements[path].slot, 17)
	assert.equal(f.layout().placements[missing], undefined)
})

test("pre-scan geometry changes remap saved slots only after loaded files are known", async () => {
	const f = await fixture()
	f.window()
	f.resize(3)
	f.resize(5)
	assert.equal(f.saves(), 0)
	assert.equal(f.grid().positions[path], 17)
	await f.scan([file])
	f.flush()
	assert.equal(f.layout().placements[path].slot, 21)
	assert.equal(f.layout().columns["monitor:screen"], 5)
})

test("failed refresh after a loaded scan keeps the last good layout until retry", async () => {
	const f = await fixture()
	f.window()
	await f.scan([file])
	const saves = f.saves()
	f.refresh()
	await f.scan({ ok: false, err: new Error("temporary scan failure") }, 1)
	assert.equal(f.grid().positions[path], 17)
	assert.equal(f.saves(), saves)
	f.refresh()
	await f.scan([file], 2)
	assert.equal(f.grid().positions[path], 17)
	f.flush()
	assert.equal(f.layout().placements[path].slot, 17)
})

test("late stale scan cannot overwrite a newer successful refresh", async () => {
	const f = await fixture()
	f.window()
	f.refresh()
	await f.scan([file], 1)
	await f.scan([], 0)
	assert.equal(f.grid().positions[path], 17)
	f.flush()
	assert.equal(f.layout().placements[path].slot, 17)
})
