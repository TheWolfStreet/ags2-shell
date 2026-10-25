import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { load_module } from "../load_module.ts"
import { with_hyprland_command } from "../hyprland.ts"
import * as result from "../../lib/result.ts"
import {
	accessor,
	create_state,
	jsx_runtime,
	make,
	nodes,
	tick,
} from "../helpers.ts"

const path = "/home/tws/Software/Music/Prefix/icons/FL Studio 21.png"

function app(entry, name, wm_class, icon) {
	return {
		get_entry: () => entry,
		get_name: () => name,
		get_wm_class: () => wm_class,
		get_executable: () => "bottles-cli run -p 'FL Studio 21'",
		get_icon_name: () => icon,
	}
}

let next_address = 1

function client(class_name, initial_class, title, initial_title = "") {
	return {
		class: class_name,
		initialClass: initial_class,
		title,
		initialTitle: initial_title,
		address: `0x${next_address++}`,
		get_title() {
			return this.title
		},
		focus() {},
		kill() {},
	}
}

const ags = {
	createBinding: (object, property) => accessor(() => object[property]),
	createComputed: (fn) => accessor(fn),
	createState: create_state,
	For: ({ each, children }) => each().map(children),
	With: ({ value, children }) => children(value()),
}

const gtk = {
	Gdk: { BUTTON_SECONDARY: 3, BUTTON_MIDDLE: 2 },
	Gtk: {
		Align: { CENTER: 1, START: 2 },
		Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
		ContentFit: { CONTAIN: 0 },
		Picture: "picture",
		Separator: "separator",
		GestureClick: "gesture",
	},
}

async function fixture() {
	const fl = app(
		"Music--FL Studio 21--1734389237.668505.desktop",
		"FL Studio 21",
		"FL Studio 21",
		path,
	)
	const editor = app("editor.desktop", "Editor", "Editor", "editor-symbolic")
	const catalog = { list: [fl, editor], favorites: [fl] }
	const settings = {
		favorites: "dock",
		trash: false,
		mode: "autohide",
		position: "bottom-center",
		taskbar: "dock",
	}
	const trash_listeners = new Set<() => void>()
	const running: ReturnType<typeof client>[] = []
	const texture_paths: [unknown, unknown][] = []
	const focused: { client: ReturnType<typeof client> | null } = {
		client: null,
	}
	const focus_calls: unknown[] = []
	const button_actions: Record<string, () => void>[] = []
	const launches: unknown[] = []
	let launch_result: unknown = result.ok(undefined)
	const ui = await load_module("lib/ui.ts", {
		ags,
		"ags/gtk4": gtk,
		"gi://Pango": { default: {} },
	})
	const application_icon = await load_module(
		"widget/shared/ApplicationIcon.tsx",
		{
			ags,
			"ags/gtk4": gtk,
			"ags/gtk4/jsx-runtime": jsx_runtime,
			"$lib/textures": {
				create_texture_accessor: (icon, size) => {
					texture_paths.push([icon, size])
					return accessor(() => icon)
				},
			},
			"$lib/ui": ui,
		},
	)
	const apps = await load_module("lib/apps.ts", {
		"gi://GioUnix": { default: {} },
		"gi://GLib": { default: {} },
		"$lib/hyprland": with_hyprland_command({ hyprland: {} }),
	})
	const imports = {
		ags,
		"ags/gtk4": gtk,
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"$lib/apps": {
			...apps,
			launch_app: async (target) => {
				launches.push(target)
				return launch_result
			},
		},
		"$lib/windowing": {
			close_client: () => {},
			create_window_client_list: () => accessor(() => running),
			create_client_title_accessor: (value) => accessor(() => value.title),
			focused_window_client: accessor(() => focused.client),
			focus_client: (target) => focus_calls.push(target),
			focus_client_and_toggle_fullscreen: () => {},
			dispatch_client_button_action: (_button, actions) =>
				button_actions.push(actions),
		},
		"$shell/options": {
			default: {
				bar: { taskbar: { exclusive: accessor(() => false) } },
				favorites: { location: accessor(() => settings.favorites) },
				dock: {
					trash: Object.assign(
						accessor(() => settings.trash),
						{
							subscribe: (fn) => {
								trash_listeners.add(fn)
								return () => trash_listeners.delete(fn)
							},
						},
					),
					mode: accessor(() => settings.mode),
					position: accessor(() => settings.position),
					scale: accessor(() => 1),
				},
				taskbar: { location: accessor(() => settings.taskbar) },
			},
			surface_scale: (scale) => scale(),
			ui_scale: () => 1,
		},
		"$service/apps": { applications: catalog },
		"$lib/time": { timeout: (_ms, callback) => callback() },
		"widget/shared/ApplicationIcon": application_icon,
		"./trash": { has_items: accessor(() => false), open_trash: () => {} },
	}
	const bar = await load_module(
		"widget/Bar/components/Buttons/WindowList.tsx",
		imports,
	)
	const dock = await load_module(
		"widget/Dock/components/dock_items.tsx",
		imports,
	)
	const dock_items = dock.create_dock_items(accessor(() => true))
	return {
		fl,
		editor,
		catalog,
		settings,
		set_trash: (value: boolean) => {
			settings.trash = value
			for (const fn of trash_listeners) fn()
		},
		imports,
		running,
		texture_paths,
		focused,
		focus_calls,
		button_actions,
		launches,
		set_launch_result: (value) => {
			launch_result = value
		},
		dock,
		dock_items,
		render_bar: () => bar.WindowList(),
		render_dock: (side = "bottom") => {
			const items = dock_items()
			return {
				items,
				trees: items.map((item) =>
					dock.render_dock_item(
						item,
						side,
						accessor(() => 64),
					),
				),
			}
		},
	}
}

test.afterEach(() => mock.restoreAll())

test("bar and dock render the catalog's absolute FL icon through the same picture loader", async () => {
	const f = await fixture()
	f.running.push(client("fl64.exe", "FL Studio 21", "Project.flp"))
	const bar = f.render_bar()
	const dock = f.render_dock()
	assert.equal(nodes(bar, "picture")[0].props.paintable(), path)
	assert.equal(nodes(dock.trees, "picture")[0].props.paintable(), path)
	assert.deepEqual(
		f.texture_paths.map(([icon, size]) => [icon, size]),
		[
			[path, 32],
			[path, 64],
		],
	)
	assert.equal(dock.items.length, 1)
	assert.equal(dock.items[0].kind, "group")
})

test("symbolic icons use theme images; catalog reload and client metadata update both taskbars", async () => {
	const f = await fixture()
	f.catalog.favorites = []
	const window = client("Editor", "", "Editor")
	f.running.push(window)
	assert.equal(
		nodes(f.render_bar(), "image")[0].props.iconName,
		"editor-symbolic",
	)
	assert.equal(
		nodes(f.render_dock().trees, "image")[0].props.iconName,
		"editor-symbolic",
	)
	assert.equal(f.texture_paths.length, 0)

	window.class = "fl64.exe"
	window.initialClass = ""
	window.title = "FL Studio 21 - Project.flp"
	assert.equal(nodes(f.render_bar(), "picture")[0].props.paintable(), path)
	assert.equal(
		nodes(f.render_dock().trees, "picture")[0].props.paintable(),
		path,
	)

	f.catalog.list = [f.editor]
	f.catalog.favorites = []
	assert.equal(nodes(f.render_bar(), "image")[0].props.iconName, "fl64.exe")
	assert.equal(
		nodes(f.render_dock().trees, "image")[0].props.iconName,
		"fl64.exe",
	)
	window.initialClass = "Editor"
	assert.equal(
		nodes(f.render_bar(), "image")[0].props.iconName,
		"editor-symbolic",
	)
	assert.equal(
		nodes(f.render_dock().trees, "image")[0].props.iconName,
		"editor-symbolic",
	)
	window.class = ""
	window.initialClass = ""
	window.title = "Untitled"
	assert.equal(
		nodes(f.render_bar(), "image")[0].props.iconName,
		"image-missing",
	)
	assert.equal(
		nodes(f.render_dock().trees, "image")[0].props.iconName,
		"image-missing",
	)
})

test("classless clients resolving to the same desktop ID share a favorite group", async () => {
	const f = await fixture()
	f.running.push(
		client("", "FL Studio 21", "Project 1"),
		client("", "", "FL Studio 21 - Project 2"),
	)
	const { items, trees } = f.render_dock()
	assert.equal(items.length, 1)
	assert.equal(items[0].kind, "group")
	assert.equal(items[0].clients.length, 2)
	assert.equal(nodes(trees, "picture")[0].props.paintable(), path)
})

test("mixed classless groups retain a generic icon and separate favorites regardless of order", async () => {
	const cases = [
		["fl", "editor", "fl"],
		["editor", "fl", "fl"],
		["fl", "unknown", "fl"],
		["unknown", "fl", "fl"],
	]
	for (const order of cases) {
		const f = await fixture()
		f.catalog.favorites = [f.fl, f.editor]
		const clients = {
			fl: client("", "FL Studio 21", "Project"),
			editor: client("", "Editor", "Document"),
			unknown: client("", "", "Untitled"),
		}
		f.running.push(clients[order[0]], clients[order[1]])
		for (const count of [2, 3]) {
			if (count === 3)
				f.running.push(client("", "FL Studio 21", "Another project"))
			const { items, trees } = f.render_dock()
			const group_index = items.findIndex((item) => item.kind === "group")
			assert.equal(items.length, 3, `${order} after ${count} clients`)
			assert.equal(items[group_index].clients.length, count)
			assert.equal(items[group_index].icon, undefined)
			assert.equal(
				nodes(trees[group_index], "image")[0].props.iconName,
				"image-missing",
			)
			assert.deepEqual(
				items
					.filter((item) => item.kind === "favorite")
					.map((item) => item.app.get_entry()),
				[f.fl.get_entry(), f.editor.get_entry()],
			)
		}
	}
})

test("unchanged dock items keep their identity across evaluations", async () => {
	const f = await fixture()
	f.catalog.favorites = [f.editor]
	f.settings.trash = true
	const window = client("fl64.exe", "FL Studio 21", "Project")
	f.running.push(window)
	const first = f.dock_items()
	assert.deepEqual(
		first.map((item) => item.kind),
		["favorite", "group", "separator", "trash"],
	)
	const second = f.dock_items()
	for (const [index, item] of second.entries())
		assert.equal(item, first[index], `item ${index}`)

	f.running.push(client("fl64.exe", "FL Studio 21", "Second"))
	const third = f.dock_items()
	assert.equal(third[0], first[0])
	assert.notEqual(third[1], first[1])
	assert.equal(third[1].clients.length, 2)
	assert.equal(third[2], first[2])
	assert.equal(third[3], first[3])

	f.running.pop()
	const shrunk = f.dock_items()
	assert.notEqual(shrunk[1], third[1])
	assert.equal(shrunk[1].clients.length, 1)

	f.catalog.favorites = [f.fl]
	const fourth = f.dock_items()
	assert.deepEqual(
		fourth.map((item) => item.kind),
		["group", "separator", "trash"],
	)
	assert.notEqual(fourth[0], third[1])

	f.running.length = 0
	f.catalog.favorites = [f.editor]
	const editor_favorite = f.dock_items()[0]
	f.catalog.favorites = [f.fl]
	const fl_favorite = f.dock_items()[0]
	assert.equal(fl_favorite.kind, "favorite")
	assert.notEqual(fl_favorite, editor_favorite)
	assert.equal(fl_favorite.app, f.fl)
})

test("trash appends a separator only after other items", async () => {
	const f = await fixture()
	f.catalog.favorites = []
	f.settings.trash = true
	assert.deepEqual(
		f.dock_items().map((item) => item.kind),
		["trash"],
	)
	f.catalog.favorites = [f.editor]
	assert.deepEqual(
		f.dock_items().map((item) => item.kind),
		["favorite", "separator", "trash"],
	)
	const left = f.render_dock("left").trees
	assert.equal(left[1].type, "separator")
	assert.equal(left[1].props.orientation, 0)
	const bottom = f.render_dock("bottom").trees
	assert.equal(bottom[1].props.orientation, 1)
	assert.equal(bottom[1].props.heightRequest(), 64)
})

test("favorites stay out of the dock unless their location includes it", async () => {
	for (const [location, kinds] of [
		["bar", ["group"]],
		["both", ["group", "favorite"]],
		["dock", ["group", "favorite"]],
	] as const) {
		const f = await fixture()
		f.catalog.favorites = [f.fl, f.editor]
		f.settings.favorites = location
		f.running.push(client("fl64.exe", "FL Studio 21", "Project"))
		assert.deepEqual(
			f.dock_items().map((item) => item.kind),
			kinds,
			location,
		)
	}
})

test("grouped icon cycles focus and draws up to three dots on the dock side", async () => {
	const f = await fixture()
	f.catalog.favorites = []
	const windows = [
		client("Editor", "", "One"),
		client("Editor", "", "Two"),
		client("Editor", "", "Three"),
		client("Editor", "", "Four"),
	]
	f.running.push(...windows)
	const [bottom] = f.render_dock("bottom").trees
	assert.equal(bottom.props.class, "dock-icon dock-horizontal")
	assert.equal(bottom.children[0].type, "button")
	const dots = bottom.children[1]
	assert.equal(dots.props.class, "window-dots")
	assert.equal(dots.props.orientation, 0)
	assert.equal(dots.children.length, 3)
	assert.equal(dots.children[0].props.class(), "window-dot")
	assert.equal(bottom.children[0].props.tooltipText, "Editor (4 windows)")

	const [left] = f.render_dock("left").trees
	assert.equal(left.props.class, "dock-icon dock-vertical")
	assert.equal(left.children[0].props.class, "window-dots")
	assert.equal(left.children[0].props.orientation, 1)
	assert.equal(left.children[1].type, "button")

	const gesture = nodes(bottom, "gesture")[0]
	const press = () =>
		gesture.props.onPressed({ get_current_button: () => 1, reset() {} })
	press()
	f.button_actions.at(-1)!.primary()
	f.focused.client = windows[1]
	assert.equal(dots.children[0].props.class(), "window-dot focused")
	press()
	f.button_actions.at(-1)!.primary()
	f.focused.client = windows[3]
	press()
	f.button_actions.at(-1)!.primary()
	f.focused.client = client("Other", "", "Elsewhere")
	press()
	f.button_actions.at(-1)!.primary()
	assert.deepEqual(f.focus_calls, [
		windows[0],
		windows[2],
		windows[0],
		windows[0],
	])
})

test("favorite launch failures are logged without blocking the click", async () => {
	const errors: unknown[][] = []
	const f = await fixture()
	mock.method(console, "error", (...args: unknown[]) => {
		if (!String(args[0]).includes("ExperimentalWarning")) errors.push(args)
	})
	f.catalog.favorites = [f.editor]
	const failure = new Error("launch failed")
	f.set_launch_result(result.err(failure))
	const [tree] = f.render_dock().trees
	const button = tree.children[0]
	assert.equal(button.props.tooltipText, "Editor")
	button.props.onClicked()
	await tick()
	assert.deepEqual(f.launches, [f.editor])
	assert.deepEqual(errors, [["dock: Could not launch application", failure]])
})

async function dock_window_fixture() {
	const f = await fixture()
	f.catalog.favorites = [f.editor]
	const cleanups: (() => void)[] = []
	const released: unknown[] = []
	const trash_watchers = { acquired: 0, released: 0 }
	const windows: Record<string, any> = {}
	const hide = { pending: null as null | (() => void), cancels: 0 }
	function surface(type, props) {
		const node = make(type, props)
		Object.assign(node, {
			controllers: [] as any[],
			signals: {} as Record<string, () => void>,
			add_controller(controller) {
				this.controllers.push(controller)
			},
			connect(signal: string, handler: () => void) {
				this.signals[signal] = handler
				return 1
			},
			get_surface: () => null,
			get_visible: () => props.visible(),
		})
		windows[props.name] = node
		props.$(node)
		return node
	}
	class EventControllerMotion {
		handlers: Record<string, () => void> = {}
		connect(signal, handler) {
			this.handlers[signal] = handler
		}
	}
	const dock_index = await load_module("widget/Dock/index.tsx", {
		...f.imports,
		ags: {
			...ags,
			createState: create_state,
			onCleanup: (fn) => cleanups.push(fn),
		},
		"ags/gtk4": {
			...gtk,
			Gtk: { ...gtk.Gtk, EventControllerMotion },
			Astal: {
				WindowAnchor: { TOP: 1, BOTTOM: 2, LEFT: 4, RIGHT: 8 },
				Layer: { TOP: 2 },
				Exclusivity: { EXCLUSIVE: 1, IGNORE: 2 },
				Keymode: { NONE: 0 },
			},
		},
		"ags/gtk4/jsx-runtime": {
			...jsx_runtime,
			jsx: (type, props) =>
				type === "window" ? surface(type, props) : make(type, props),
			jsxs: (type, props) =>
				type === "window" ? surface(type, props) : make(type, props),
		},
		cairo: {
			default: {
				Region: class {
					rects: unknown[] = []
					unionRectangle(rect) {
						this.rects.push(rect)
					}
				},
			},
		},
		"$lib/time": {
			idle: (fn) => {
				fn()
				return { cancel() {} }
			},
			debounce: (_ms, fn) => ({
				call: () => {
					hide.pending = fn
				},
				cancel: () => {
					hide.pending = null
					hide.cancels++
				},
			}),
		},
		"$lib/windowing": {
			...f.imports["$lib/windowing"],
			track_monitor_fullscreen: () => accessor(() => false),
			schedule_monitor_window_release: (window) =>
				released.push(window.props.name),
		},
		"widget/shared/PopupWindow": {
			PopupWindow: (props) => surface("popup-window", props),
		},
		"./components/dock_items": f.dock,
		"./components/trash": {
			acquire_trash_watcher: () => {
				trash_watchers.acquired++
				return () => trash_watchers.released++
			},
		},
	})
	dock_index.Dock.Window({
		gdkmonitor: { geometry: { x: 0, y: 0, width: 1920, height: 1080 } },
	})
	const motion = (name) => windows[name].controllers[0].handlers
	return {
		...f,
		windows,
		motion,
		hide,
		released,
		trash_watchers,
		cleanup: () => {
			for (const fn of cleanups) fn()
		},
	}
}

test("dock surfaces follow the hover zones and hide after the last leave", async () => {
	const d = await dock_window_fixture()
	const dock = d.windows["dock-bottom"]
	const hotzone = d.windows["dock-hotzone-bottom"]
	assert.equal(dock.type, "popup-window")
	assert.equal(dock.props.layout, "bottom-center")
	assert.equal(dock.props.anchor, 2 | 4 | 8)
	assert.equal(d.windows["dock-left"].props.layout, "center-left")
	assert.equal(d.windows["dock-left"].props.anchor, 4 | 1 | 2)
	assert.equal(dock.children[0].props.class(), "dock-container dock-horizontal")
	assert.equal(dock.props.heightRequest(), 94)
	assert.equal(dock.props.widthRequest, -1)
	assert.equal(hotzone.props.heightRequest(), 22)
	assert.equal(hotzone.props.visible(), true)
	assert.equal(d.windows["dock-hotzone-left"].props.visible(), false)
	assert.equal(dock.props.visible(), false)
	assert.equal(dock.props.exclusivity(), 2)

	d.motion("dock-hotzone-bottom").enter()
	assert.equal(dock.props.visible(), true)
	d.motion("dock-bottom").enter()
	d.motion("dock-hotzone-bottom").leave()
	assert.equal(d.hide.pending, null)
	d.motion("dock-bottom").leave()
	assert.notEqual(d.hide.pending, null)
	d.motion("dock-bottom").enter()
	assert.equal(d.hide.pending, null)
	d.motion("dock-bottom").leave()
	d.hide.pending!()
	assert.equal(dock.props.visible(), false)

	d.motion("dock-bottom").enter()
	d.hide.pending = null
	dock.props.onNotifyVisible({ get_visible: () => true })
	assert.equal(d.hide.pending, null)
	dock.props.onNotifyVisible({ get_visible: () => false })
	assert.notEqual(d.hide.pending, null)
	d.motion("dock-hotzone-bottom").enter()
	d.hide.pending = null
	hotzone.props.onNotifyVisible({ get_visible: () => false })
	assert.notEqual(d.hide.pending, null)

	d.settings.mode = "static"
	assert.equal(dock.props.exclusivity(), 1)
	assert.equal(dock.props.visible(), true)
	assert.equal(hotzone.props.visible(), false)
	d.settings.position = "center-left"
	assert.equal(dock.props.visible(), false)
	assert.equal(d.windows["dock-left"].props.visible(), true)
	assert.equal(
		d.windows["dock-left"].children[0].props.class(),
		"dock-container dock-vertical",
	)
	assert.equal(d.windows["dock-left"].props.widthRequest(), 94)
	assert.equal(d.windows["dock-left"].props.defaultWidth, 1)
	assert.equal(d.windows["dock-bottom"].props.defaultHeight, 1)
})

test("the dock only takes input on its visible box", async () => {
	const d = await dock_window_fixture()
	const dock = d.windows["dock-bottom"]
	const regions: unknown[] = []
	const layouts: (() => void)[] = []
	const disconnected: number[] = []
	const surface = {
		connect: (_signal: string, handler: () => void) => {
			layouts.push(handler)
			return 3
		},
		disconnect: (id: number) => disconnected.push(id),
		set_input_region: (region) => regions.push(region.rects),
	}
	dock.get_surface = () => surface
	dock.children[0].props.$({
		compute_bounds: () => [
			true,
			{ origin: { x: 700.4, y: 10 }, size: { width: 520.2, height: 84 } },
		],
	})
	dock.signals.map()
	assert.deepEqual(regions.at(-1), [{ x: 700, y: 10, width: 521, height: 84 }])
	dock.signals.map()
	assert.equal(layouts.length, 1)
	regions.length = 0
	layouts[0]()
	assert.equal(regions.length, 1)
	d.cleanup()
	assert.deepEqual(disconnected, [3])
})

test("the dock holds a trash watcher only while the option is on and releases on cleanup", async () => {
	const d = await dock_window_fixture()
	assert.deepEqual(d.trash_watchers, { acquired: 0, released: 0 })
	d.set_trash(true)
	d.set_trash(true)
	assert.deepEqual(d.trash_watchers, { acquired: 1, released: 0 })
	d.set_trash(false)
	d.set_trash(false)
	assert.deepEqual(d.trash_watchers, { acquired: 1, released: 1 })
	d.set_trash(true)
	assert.deepEqual(d.trash_watchers, { acquired: 2, released: 1 })
	const cancels = d.hide.cancels
	d.cleanup()
	assert.deepEqual(d.trash_watchers, { acquired: 2, released: 2 })
	d.set_trash(false)
	assert.deepEqual(d.trash_watchers, { acquired: 2, released: 2 })
	assert.equal(d.hide.cancels, cancels + 1)
	assert.deepEqual(d.released, [
		"dock-hotzone-left",
		"dock-hotzone-bottom",
		"dock-left",
		"dock-bottom",
	])
})
