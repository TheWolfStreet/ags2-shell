import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as result from "../../lib/result.ts"
import {
	accessor,
	create_state,
	with_hyprland_command,
	flush_ticks as settle,
	push_idle,
} from "../helpers.ts"

const path = "/mock/Desktop/keep"
const missing = "/mock/Desktop/missing"
const file = { name: "keep", path }
const desktop_directory = "/mock/Desktop"
const unexpected = [
	"clear_clipboard_file_payload",
	"create_desktop_folder",
	"create_desktop_launcher",
	"create_desktop_text_file",
	"delete_desktop_files",
	"open_path",
	"read_clipboard_file_payload",
	"rename_file",
	"transfer_desktop_files",
	"write_clipboard_file_payload",
]

function metrics(columns, rows = 8) {
	return {
		rows,
		columns,
		cell_width: 100,
		cell_height: 100,
		offset_x: 0,
		offset_y: 0,
		padding_right: 0,
		padding_bottom: 0,
	}
}

function desktop_entry(name: string) {
	return { name, path: `${desktop_directory}/${name}` }
}

type file_monitor = {
	path: string
	flags: number
	cancelled: boolean
	changed: () => void
}

function fake_gio(existing: Set<string>, monitors: file_monitor[]) {
	function file_at(file_path: string) {
		return {
			path: file_path,
			query_exists: () => existing.has(file_path),
			equal: (other) => other.path === file_path,
			get_parent: () => {
				if (file_path === "/") return null
				return file_at(file_path.slice(0, file_path.lastIndexOf("/")) || "/")
			},
			monitor_directory: (flags) => {
				const monitor: file_monitor = {
					path: file_path,
					flags,
					cancelled: false,
					changed: () => {},
				}
				monitors.push(monitor)
				return {
					connect: (_event, fn) => {
						monitor.changed = fn
					},
					cancel: () => {
						monitor.cancelled = true
					},
				}
			},
		}
	}
	return {
		File: { new_for_path: file_at },
		FileMonitorFlags: { NONE: 0, WATCH_MOVES: 1 },
	}
}

async function fixture({
	existing_paths = ["/", "/mock", desktop_directory],
} = {}) {
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
	let write_mode: "ok" | "false" | "throw" = "ok"
	const errors: unknown[][] = []
	const existing = new Set(existing_paths)
	const monitors: file_monitor[] = []
	const idles: (() => void)[] = []
	const scans: ((value: unknown) => void)[] = []
	const shutdown: (() => void)[] = []
	const calls: unknown[][] = []
	const clipboard = {
		local: true,
		content: "content",
		connect: () => 7,
		disconnect: () => {},
		is_local: () => clipboard.local,
		get_content: () => clipboard.content,
	}
	const operations: Record<string, (...args: any[]) => any> = {}
	for (const name of unexpected)
		operations[name] = () => {
			throw new Error(`unexpected ${name}`)
		}
	const monitor = {
		get_geometry: () => ({ x: 0, y: 0, width: 400, height: 900 }),
		get_connector: () => "screen",
	}
	const hypr_handlers = new Map<string, (...args: any[]) => void>()
	const focused: unknown[] = []
	const hyprland = {
		monitors: accessor(() => [{ name: "screen" }]),
		cursorPosition: { x: 0, y: 0 },
		connect: (signal, fn) => {
			hypr_handlers.set(signal, fn)
			return 1
		},
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
	const ags = {
		createState: create_state,
		createComputed: accessor,
		createBinding: (object, property) =>
			property === "monitors"
				? object.monitors
				: accessor(() => object.get_geometry()),
		onCleanup: () => {},
	}
	const gtk = {
		Gdk: {
			Display: {
				get_default: () => ({
					get_clipboard: () => clipboard,
					get_monitors: () => ({ connect: () => 3, disconnect: () => {} }),
				}),
			},
		},
		Gtk: {},
		Astal: {
			Layer: { BOTTOM: 0 },
			Exclusivity: { IGNORE: 0 },
			Keymode: { ON_DEMAND: 0 },
			WindowAnchor: { TOP: 1, BOTTOM: 2, LEFT: 4, RIGHT: 8 },
		},
	}
	const time = {
		idle: push_idle(idles),
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
	}
	const glib = {
		FileTest: { EXISTS: 1 },
		file_test: () => true,
		file_set_contents: (_name, value) => {
			if (write_mode === "throw") throw new Error("disk unavailable")
			if (write_mode === "false") return false
			disk = value
			writes++
			return true
		},
	}
	const file_operations = {
		desktop_path: desktop_directory,
		load_desktop_files: () => new Promise((resolve) => scans.push(resolve)),
		...Object.fromEntries(
			unexpected.map((name) => [
				name,
				(...args) => {
					calls.push([name, ...args])
					return operations[name](...args)
				},
			]),
		),
	}
	const original_error = console.error
	console.error = (...args) => errors.push(args)
	const geometry = await load_module("widget/Desktop/grid_geometry.ts")
	const desktop = await load_module("widget/Desktop/desktop.ts", {
		"$lib/app": { default: app },
		ags,
		"ags/file": { readFile: () => disk },
		"ags/gtk4": gtk,
		"$lib/time": time,
		"gi://Gio": { default: fake_gio(existing, monitors) },
		"gi://GLib": { default: glib },
		"$lib/env": { default: { paths: { cache: { base: "/mock/cache" } } } },
		"./file_operations": file_operations,
		"./grid_geometry": geometry,
	})
	const index = await load_module("widget/Desktop/index.tsx", {
		"$lib/app": { default: app },
		ags,
		"ags/gtk4": gtk,
		"ags/gtk4/jsx-runtime": {
			jsx: (type, props) => ({ type, props }),
			jsxs: (type, props) => ({ type, props }),
		},
		"$lib/time": time,
		"gi://AstalHyprland": { default: {} },
		"$lib/windowing": {
			focus_client: (client) => focused.push(client),
			schedule_monitor_window_release: () => {},
		},
		"$lib/ui": { font_size: () => 11 },
		"$lib/hyprland": with_hyprland_command({ hyprland }),
		"$shell/options": {
			default: options,
			surface_scale: fixed(1),
			ui_scale: fixed(1),
		},
		"widget/Dock": { dock_window_thickness: () => 0 },
		"./components/Grid": {
			attach_desktop_keyboard: () => {},
			DesktopGrid: () => null,
		},
		"./components/ContextMenu": { DesktopContextMenu: () => null },
		"./DragAndDrop": { create_desktop_drag_controller: () => ({}) },
		"./desktop": desktop,
		"./grid_geometry": geometry,
	})
	console.error = original_error
	return {
		desktop,
		operations,
		calls,
		clipboard,
		monitors,
		existing,
		window: () => index.Desktop.Window({ gdkmonitor: monitor }),
		hyprland,
		focused,
		client_added: (client) =>
			hypr_handlers.get("client-added")!(hyprland, client),
		grid: (id = "monitor:screen") => desktop.get_desktop_grid(id),
		layout: () => JSON.parse(disk),
		saves: () => saves,
		errors: () => errors,
		save_errors: () =>
			errors.filter(([tag]) => String(tag).startsWith("desktop.save:")),
		fail_writes: (mode: "ok" | "false" | "throw") => {
			write_mode = mode
		},
		flush: () => shutdown[0](),
		flush_idle: () => {
			for (const fn of idles.splice(0)) fn()
		},
		resize: (next, id = "monitor:screen") =>
			desktop.resize_desktop_grid(id, metrics(next)),
		refresh: () => monitors.at(-1)!.changed(),
		scan: async (value, index = 0) => {
			assert.ok(scans[index], `scan ${index} not requested`)
			scans[index](value.ok === false ? value : { ok: true, value })
			await settle()
		},
		scans: () => scans.length,
		settle,
		capture: async (run: () => unknown) => {
			console.error = (...args) => errors.push(args)
			try {
				await run()
				await settle()
			} finally {
				console.error = original_error
			}
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
	await f.capture(() =>
		f.scan({ ok: false, err: new Error("directory unavailable") }),
	)
	assert.equal(f.saves(), 0)
	assert.equal(f.grid().positions[path], 17)
	assert.equal(
		f.errors()[0][0],
		"desktop.load_desktop_files: Failed to load desktop files",
	)
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
	await f.capture(() =>
		f.scan({ ok: false, err: new Error("temporary scan failure") }, 1),
	)
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

test("layout write returning false is reported and leaves the saved layout untouched", async () => {
	const f = await fixture()
	f.window()
	await f.scan([file])
	f.fail_writes("false")
	await f.capture(() => f.flush())
	assert.equal(f.layout().placements[missing].slot, 19)
	const errors = f.save_errors()
	assert.equal(errors.length, 1)
	assert.equal(errors[0][0], "desktop.save: Failed to save desktop layout")
	assert.equal((errors[0][1] as Error).message, "Layout write returned false")
})

test("layout write that throws is reported with the original error", async () => {
	const f = await fixture()
	f.window()
	await f.scan([file])
	f.fail_writes("throw")
	await f.capture(() => f.flush())
	const errors = f.save_errors()
	assert.equal(errors.length, 1)
	assert.equal((errors[0][1] as Error).message, "disk unavailable")
})

test("icons of a disconnected monitor are projected onto the primary grid", async () => {
	const f = await fixture()
	const a = desktop_entry("a")
	const b = desktop_entry("b")
	const c = desktop_entry("c")
	const d = desktop_entry("d")
	const e = desktop_entry("e")
	f.resize(2, "monitor:screen")
	f.resize(2, "monitor:gone")
	f.resize(2, "monitor:gone2")
	await f.scan([a, e, b, c, d])
	f.desktop.move_desktop_files({
		to: "monitor:gone2",
		paths: [e.path],
		slot: 0,
	})
	f.desktop.move_desktop_files({
		to: "monitor:gone",
		paths: [b.path, c.path, d.path],
		slot: 0,
	})
	f.desktop.move_desktop_files({ to: "monitor:gone", paths: [c.path], slot: 3 })
	f.desktop.set_desktop_monitors(["monitor:screen"], "MONITOR:Screen ")
	const grid = f.grid()
	assert.deepEqual(
		grid.files.map((item) => item.name),
		["a", "b", "e", "c", "d"],
	)
	assert.deepEqual(grid.positions, {
		[a.path]: 0,
		[b.path]: 1,
		[e.path]: 2,
		[c.path]: 3,
		[d.path]: 4,
	})
	f.desktop.set_desktop_monitors([], "monitor:screen")
	assert.deepEqual(
		f.grid().files.map((item) => item.name),
		["a", "b", "e", "c", "d"],
	)
	f.desktop.move_desktop_files({
		to: "monitor:screen",
		paths: [b.path],
		slot: 1,
	})
	assert.equal(f.desktop.monitor_of_desktop_path(b.path), "monitor:screen")
	assert.equal(f.grid().positions[b.path], 1)
	f.desktop.set_desktop_monitors(
		["monitor:screen", "monitor:gone"],
		"monitor:screen",
	)
	assert.deepEqual(
		f.grid().files.map((item) => item.name),
		["a", "b", "e"],
	)
})

test("a cross-monitor drop grows the target grid to fit the incoming icons", async () => {
	const f = await fixture()
	const a = desktop_entry("a")
	const b = desktop_entry("b")
	const c = desktop_entry("c")
	f.resize(2, "monitor:screen")
	f.desktop.resize_desktop_grid("monitor:small", metrics(2, 1))
	await f.scan([a, b, c])
	f.desktop.move_desktop_files({
		to: "monitor:small",
		paths: [a.path],
		slot: 1,
	})
	const saves = f.saves()
	f.desktop.resize_desktop_grid("monitor:small", metrics(2, 1))
	assert.equal(f.saves(), saves)
	f.desktop.move_desktop_files({
		to: "monitor:small",
		paths: [b.path, c.path],
		slot: 1,
		anchor: c.path,
	})
	f.flush()
	assert.deepEqual(
		[a, b, c].map((item) => f.layout().placements[item.path]),
		[
			{ monitor: "monitor:small", slot: 1 },
			{ monitor: "monitor:small", slot: 0 },
			{ monitor: "monitor:small", slot: 3 },
		],
	)
})

test("moving icons swaps within a monitor and reassigns them across monitors", async () => {
	const f = await fixture()
	const a = desktop_entry("a")
	const b = desktop_entry("b")
	const c = desktop_entry("c")
	f.resize(2, "monitor:screen")
	f.resize(3, "monitor:other")
	await f.scan([a, b, c])
	assert.deepEqual(f.grid().positions, {
		[a.path]: 0,
		[b.path]: 2,
		[c.path]: 4,
	})
	f.desktop.move_desktop_files({
		to: "monitor:screen",
		paths: [a.path, a.path, ""],
		slot: 2,
	})
	assert.deepEqual(f.grid().positions, {
		[a.path]: 2,
		[b.path]: 0,
		[c.path]: 4,
	})
	f.desktop.move_desktop_files({
		to: "Monitor:Other",
		paths: [b.path, c.path],
		slot: 4,
		anchor: c.path,
	})
	assert.deepEqual(f.grid("monitor:other").positions, {
		[b.path]: 1,
		[c.path]: 7,
	})
	assert.equal(f.desktop.monitor_of_desktop_path(c.path), "monitor:other")
	assert.equal(f.desktop.monitor_of_desktop_path(""), null)
	assert.deepEqual(f.grid().positions, { [a.path]: 2 })
	f.desktop.move_desktop_files({ to: "monitor:screen", paths: [], slot: 0 })
	f.desktop.move_desktop_files({
		to: "monitor:unknown",
		paths: [a.path],
		slot: 0,
	})
	assert.deepEqual(f.grid().positions, { [a.path]: 2 })
})

test("rename commits through the file layer, keeps the slot and follows the new path", async () => {
	const f = await fixture()
	const a = { ...desktop_entry("a.txt"), display_name: "Shown" }
	const launcher = { ...desktop_entry("app.desktop"), display_name: "App" }
	f.resize(2)
	await f.scan([a, launcher])
	const { rename } = f.desktop.desktop_interaction
	rename.begin(a.path)
	assert.equal(rename.path.peek(), a.path)
	assert.equal(rename.value.peek(), "a.txt")
	assert.deepEqual(f.desktop.desktop_interaction.selected.peek(), [a.path])
	rename.begin(a.path)
	assert.equal(rename.path.peek(), null)
	f.flush_idle()
	assert.equal(rename.path.peek(), a.path)
	rename.set_value("  a.txt ")
	rename.commit()
	assert.equal(rename.path.peek(), null)
	assert.deepEqual(f.calls, [])
	const slot = f.grid().positions[a.path]
	f.operations.rename_file = (_target, name) =>
		result.ok(`${desktop_directory}/${name}`)
	rename.begin(a.path)
	rename.set_value(" b.txt ")
	rename.commit()
	assert.deepEqual(f.calls, [["rename_file", a.path, "b.txt"]])
	assert.deepEqual(f.desktop.desktop_interaction.selected.peek(), [
		`${desktop_directory}/b.txt`,
	])
	assert.equal(rename.path.peek(), null)
	assert.deepEqual(
		f.desktop.desktop_file_by_path(`${desktop_directory}/b.txt`),
		{
			name: "b.txt",
			path: `${desktop_directory}/b.txt`,
			display_name: undefined,
		},
	)
	assert.equal(f.grid().positions[`${desktop_directory}/b.txt`], slot)
	rename.begin(launcher.path)
	rename.set_value("tool.DESKTOP")
	rename.commit()
	assert.equal(
		f.desktop.desktop_file_by_path(`${desktop_directory}/tool.DESKTOP`)
			.display_name,
		"App",
	)
	f.operations.rename_file = () => result.err(new Error("exists"))
	rename.begin(`${desktop_directory}/b.txt`)
	rename.set_value("c.txt")
	await f.capture(() => rename.commit())
	assert.equal(rename.path.peek(), null)
	assert.deepEqual(f.desktop.desktop_interaction.selected.peek(), [
		`${desktop_directory}/b.txt`,
	])
	assert.equal(
		f.errors().at(-1)![0],
		"desktop.rename: Failed to rename desktop file",
	)
	rename.begin(launcher.path)
	rename.cancel()
	assert.equal(rename.path.peek(), null)
})

test("removal prunes selection, press and rename of removed paths and reports failures", async () => {
	const f = await fixture()
	const a = desktop_entry("a")
	const b = desktop_entry("b")
	await f.scan([a, b])
	const interaction = f.desktop.desktop_interaction
	interaction.select([a.path, b.path])
	interaction.press(a.path)
	interaction.rename.begin(a.path)
	interaction.select([a.path, b.path])
	f.operations.delete_desktop_files = async () => ({
		removed_paths: [a.path],
		failures: [{ path: b.path, error: "busy" }],
	})
	await f.capture(async () => {
		const removed = f.desktop.remove_desktop_files([a.path, b.path], {
			permanently: true,
		})
		await f.settle()
		await f.scan([b], 1)
		await removed
	})
	assert.deepEqual(f.calls.at(-1), [
		"delete_desktop_files",
		{ paths: [a.path, b.path], operation: "delete" },
	])
	assert.deepEqual(interaction.selected.peek(), [b.path])
	assert.equal(interaction.pressed.peek(), null)
	assert.equal(interaction.rename.path.peek(), null)
	assert.deepEqual(f.errors().at(-1), [
		"desktop.remove: Failed to remove files",
		[{ path: b.path, error: "busy" }],
	])
	await f.desktop.remove_desktop_files([])
	assert.equal(f.calls.length, 1)
})

test("a rescan drops selection, press and rename of vanished files", async () => {
	const f = await fixture()
	const a = desktop_entry("a")
	const b = desktop_entry("b")
	await f.scan([a, b])
	const interaction = f.desktop.desktop_interaction
	interaction.rename.begin(b.path)
	interaction.select([a.path, b.path])
	interaction.press(b.path)
	f.refresh()
	await f.scan([a], 1)
	assert.deepEqual(interaction.selected.peek(), [a.path])
	assert.equal(interaction.pressed.peek(), null)
	assert.equal(interaction.rename.path.peek(), null)
})

test("created entries are placed on the requesting monitor", async () => {
	const f = await fixture()
	f.resize(2, "monitor:side")
	await f.scan([])
	f.operations.create_desktop_folder = () =>
		result.ok(`${desktop_directory}/New Folder`)
	f.operations.create_desktop_text_file = () =>
		result.err(new Error("read-only"))
	f.operations.create_desktop_launcher = (spec) =>
		result.ok(`${desktop_directory}/${spec.name}.desktop`)
	assert.equal(
		f.desktop.create_desktop_entry("monitor:side", { kind: "folder" }),
		`${desktop_directory}/New Folder`,
	)
	await f.scan([desktop_entry("New Folder")], 1)
	assert.equal(
		f.desktop.monitor_of_desktop_path(`${desktop_directory}/New Folder`),
		"monitor:side",
	)
	await f.capture(() => {
		assert.equal(
			f.desktop.create_desktop_entry("monitor:side", { kind: "file" }),
			null,
		)
	})
	assert.equal(
		f.errors().at(-1)![0],
		"desktop.create: Failed to create desktop file",
	)
	assert.equal(
		f.desktop.create_desktop_entry("monitor:side", {
			kind: "launcher",
			name: "Tool",
		}),
		`${desktop_directory}/Tool.desktop`,
	)
	assert.deepEqual(f.calls.at(-1), [
		"create_desktop_launcher",
		{ kind: "launcher", name: "Tool" },
	])
	assert.equal(
		f.desktop.monitor_of_desktop_path(`${desktop_directory}/Tool.desktop`),
		"monitor:side",
	)
})

test("imports place created and conflicting files on the target monitor, then rescan once", async () => {
	const f = await fixture()
	await f.scan([])
	let finish_transfer
	f.operations.transfer_desktop_files = () =>
		new Promise((resolve) => {
			finish_transfer = resolve
		})
	let imported
	await f.capture(async () => {
		imported = f.desktop.import_files_to_desktop({
			paths: ["/src/x", "/src/y"],
			to: "monitor:side",
			operation: "copy",
		})
		f.refresh()
		assert.equal(f.scans(), 1)
		finish_transfer({
			created_paths: [`${desktop_directory}/x`],
			failures: [
				{
					path: "/src/y",
					error: "exists",
					destination: `${desktop_directory}/y`,
				},
				{ path: "/src/z", error: "gone" },
			],
		})
		await f.settle()
	})
	assert.deepEqual(f.calls.at(-1), [
		"transfer_desktop_files",
		{ paths: ["/src/x", "/src/y"], operation: "copy" },
	])
	assert.equal(f.scans(), 2)
	assert.equal(
		f.desktop.monitor_of_desktop_path(`${desktop_directory}/x`),
		"monitor:side",
	)
	assert.equal(
		f.desktop.monitor_of_desktop_path(`${desktop_directory}/y`),
		"monitor:side",
	)
	assert.equal(
		f.errors().at(-1)![0],
		"desktop.import_files: Failed to import some desktop files",
	)
	await f.scan([], 1)
	assert.equal((await imported).created_paths.length, 1)
})

test("cut, paste and cancel keep the system clipboard in sync only while it is unchanged", async () => {
	const f = await fixture()
	await f.scan([])
	const payloads: unknown[] = []
	f.operations.write_clipboard_file_payload = ({ operation, paths }) => {
		payloads.push([operation, paths])
		return result.ok(undefined)
	}
	f.operations.clear_clipboard_file_payload = () => {
		payloads.push(["clear"])
		return result.ok(undefined)
	}
	f.operations.read_clipboard_file_payload = async () => ({
		operation: "cut",
		paths: ["/src/a"],
	})
	f.operations.transfer_desktop_files = async () => ({
		created_paths: ["/mock/Desktop/a"],
		failures: [],
	})
	f.desktop.copy_desktop_files(["", ""])
	assert.deepEqual(payloads, [])
	f.desktop.cut_desktop_files(["/src/a", "/src/a", ""])
	assert.deepEqual(payloads, [["cut", ["/src/a"]]])
	assert.deepEqual(f.desktop.desktop_clipboard.peek(), {
		operation: "cut",
		paths: ["/src/a"],
	})
	const pasted = f.desktop.paste_desktop_files(" ")
	await f.settle()
	await f.scan([desktop_entry("a")], 1)
	await pasted
	assert.deepEqual(f.calls.at(-2), [
		"transfer_desktop_files",
		{ paths: ["/src/a"], operation: "move" },
	])
	assert.deepEqual(payloads.at(-1), ["clear"])
	assert.equal(f.desktop.desktop_clipboard.peek(), null)

	f.desktop.cut_desktop_files(["/src/a"])
	f.clipboard.local = false
	await f.desktop.cancel_desktop_cut()
	assert.deepEqual(payloads.at(-1), ["cut", ["/src/a"]])
	assert.equal(f.desktop.desktop_clipboard.peek(), null)
	f.clipboard.local = true
	f.desktop.cut_desktop_files(["/src/a"])
	await f.desktop.cancel_desktop_cut()
	assert.deepEqual(payloads.at(-1), ["clear"])
	assert.equal(f.desktop.desktop_clipboard.peek(), null)

	f.desktop.copy_desktop_files(["/src/a"])
	f.operations.read_clipboard_file_payload = async () => ({
		operation: "copy",
		paths: ["/src/a"],
	})
	await f.desktop.cancel_desktop_cut()
	assert.deepEqual(f.desktop.desktop_clipboard.peek(), {
		operation: "copy",
		paths: ["/src/a"],
	})
	f.desktop.cut_desktop_files(["/src/b"])
	f.operations.read_clipboard_file_payload = async () => ({
		operation: "cut",
		paths: ["/src/a"],
	})
	await f.desktop.cancel_desktop_cut()
	assert.deepEqual(payloads.at(-1), ["cut", ["/src/b"]])
	f.desktop.cut_desktop_files(["/src/a"])
	const before = payloads.length
	f.operations.read_clipboard_file_payload = async () => {
		f.clipboard.content = "other"
		return { operation: "cut", paths: ["/src/a"] }
	}
	await f.desktop.cancel_desktop_cut()
	assert.equal(payloads.length, before)
	assert.equal(f.desktop.desktop_clipboard.peek(), null)
})

test("a missing desktop is watched through its nearest existing parent until it appears", async () => {
	const f = await fixture({ existing_paths: ["/", "/mock"] })
	assert.deepEqual(
		f.monitors.map(({ path, flags }) => [path, flags]),
		[["/mock", 0]],
	)
	f.monitors[0].changed()
	assert.equal(f.monitors.length, 1)
	f.existing.add(desktop_directory)
	f.monitors[0].changed()
	assert.equal(f.monitors[0].cancelled, true)
	assert.deepEqual(
		f.monitors.map(({ path, flags }) => [path, flags]),
		[
			["/mock", 0],
			[desktop_directory, 1],
		],
	)
	assert.equal(f.scans(), 2)
	await f.scan([file], 1)
	f.monitors[1].changed()
	assert.equal(f.scans(), 3)
	f.existing.delete(desktop_directory)
	f.monitors[1].changed()
	assert.equal(f.monitors[1].cancelled, true)
	assert.deepEqual(f.grid().files, [])
	assert.deepEqual(f.monitors.at(-1)!.path, "/mock")
	await f.scan([file], 2)
	assert.deepEqual(f.grid().files, [])
})

test("a parent watch moves closer when an intermediate directory appears", async () => {
	const f = await fixture({ existing_paths: ["/"] })
	assert.equal(f.monitors[0].path, "/")
	f.monitors[0].changed()
	assert.equal(f.monitors.length, 1)
	f.existing.add("/mock")
	f.monitors[0].changed()
	assert.equal(f.monitors[0].cancelled, true)
	assert.equal(f.monitors[1].path, "/mock")
})

test("a client opened under the cursor on the active desktop takes focus", async () => {
	const f = await fixture()
	const tree = f.window()
	const window = { is_active: false }
	tree.props.$(window)
	const client = { x: 100, y: 50, width: 200, height: 100 }
	const at = (x: number, y: number) => {
		f.hyprland.cursorPosition = { x, y }
		f.client_added(client)
		f.flush_idle()
	}
	at(150, 60)
	assert.deepEqual(f.focused, [])
	window.is_active = true
	for (const [x, y] of [
		[99, 60],
		[300, 60],
		[150, 49],
		[150, 150],
	])
		at(x, y)
	assert.deepEqual(f.focused, [])
	at(100, 50)
	at(299, 149)
	assert.deepEqual(f.focused, [client, client])
})
