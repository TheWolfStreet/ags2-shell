import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as geometry from "../../widget/Desktop/grid_geometry.ts"
import { nodes } from "../helpers.ts"

const keys = {
	KEY_A: 65,
	KEY_C: 67,
	KEY_V: 86,
	KEY_X: 88,
	KEY_a: 97,
	KEY_c: 99,
	KEY_v: 118,
	KEY_x: 120,
	KEY_Delete: 1,
	KEY_Escape: 2,
	KEY_F2: 3,
	KEY_ISO_Left_Tab: 4,
	KEY_Return: 5,
	KEY_Shift_L: 6,
	KEY_Shift_R: 7,
	KEY_Tab: 8,
}
const control = 4
const shift = 1
const primary = 1
const secondary = 3

async function fixture() {
	const subscribers = new Set<() => void>()
	const make_accessor = (read) =>
		Object.assign(() => read(), {
			peek: read,
			subscribe: (callback) => {
				subscribers.add(callback)
				return () => subscribers.delete(callback)
			},
			as: (fn) => make_accessor(() => fn(read())),
		})
	function state<T>(initial: T) {
		let value = initial
		return [
			make_accessor(() => value),
			(next: T) => {
				value = next
				for (const callback of [...subscribers]) callback()
			},
		] as const
	}
	const calls: unknown[][] = []
	const errors: unknown[][] = []
	const cleanups: (() => void)[] = []
	const record =
		(name: string, value?: (...args: any[]) => unknown) =>
		(...args) => {
			calls.push([name, ...args])
			return value?.(...args)
		}
	let failure: unknown = null
	const settle_task = () =>
		failure ? Promise.reject(failure) : Promise.resolve()
	const [selected, set_selected] = state<string[]>([])
	const [pressed, set_pressed] = state<string | null>(null)
	const [rename_path, set_rename_path] = state<string | null>(null)
	const [enabled, set_enabled] = state(true)
	const [clipboard, set_clipboard] = state<{
		operation: string
		paths: string[]
	} | null>(null)
	const [drag_state, set_drag_state] = state<{ paths: string[] }>({ paths: [] })
	const [grid, set_grid] = state<{
		id: string
		metrics: Record<string, number>
		files: { path: string }[]
		positions: Record<string, number>
	}>({
		id: "monitor:a",
		metrics: {
			cell_width: 10,
			cell_height: 10,
			rows: 2,
			columns: 3,
			offset_x: 0,
			offset_y: 0,
			padding_right: 0,
			padding_bottom: 5,
		},
		files: [{ path: "/d/one" }, { path: "/d/two" }, { path: "/d/three" }],
		positions: { "/d/one": 0, "/d/two": 1, "/d/three": 4 },
	})
	let now = 0
	const icons: Record<string, any>[] = []
	class Widget {}
	class Entry extends Widget {}
	const make = (type, props: Record<string, any> = {}) => {
		if (typeof type === "function") return type(props)
		const children = [props.children ?? []].flat(Infinity)
		return { type, props, children }
	}
	const options = {
		desktop: { enabled, iconSize: Object.assign(() => "small", {}) },
	}
	options.desktop.enabled.peek = enabled.peek
	const imports = {
		ags: {
			createState: state,
			createComputed: (fn) => make_accessor(fn),
			For: (props) => ({ type: "For", props, children: [] }),
			onCleanup: (fn) => cleanups.push(fn),
		},
		"ags/gtk4": {
			Gdk: {
				...keys,
				BUTTON_PRIMARY: primary,
				BUTTON_SECONDARY: secondary,
				ModifierType: { CONTROL_MASK: control, SHIFT_MASK: shift },
			},
			Gtk: {
				Align: { FILL: 0, START: 1 },
				PolicyType: { NEVER: 0, AUTOMATIC: 1 },
				PickFlags: { DEFAULT: 0 },
				PropagationPhase: { CAPTURE: 1 },
				Widget,
				Entry,
				EventControllerKey: class {
					handlers = new Map()
					constructor(props) {
						calls.push(["key_controller", props])
					}
					connect(name, fn) {
						this.handlers.set(name, fn)
					}
				},
				EventControllerMotion: "EventControllerMotion",
				DropControllerMotion: "DropControllerMotion",
				GestureClick: "GestureClick",
				GestureDrag: "GestureDrag",
				ScrolledWindow: "ScrolledWindow",
				Fixed: "Fixed",
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make, Fragment: "fragment" },
		"gi://GLib": { default: { get_monotonic_time: () => now } },
		"$shell/options": { default: options, ui_scale: () => 1 },
		"../grid_geometry": geometry,
		"../DragAndDrop": {
			DragLayer: (props) => ({ type: "DragLayer", props, children: [] }),
		},
		"./Icon": {
			DesktopIcon: (props) => {
				icons.push(props)
				return { type: "icon", props, children: [] }
			},
		},
		"./ContextMenu": {
			desktop_context_menu: {
				set_shift_held: record("set_shift_held"),
				hide: record("hide"),
				show: record("show"),
				enter_desktop: record("enter_desktop"),
				leave_desktop: record("leave_desktop"),
			},
		},
		"../desktop": {
			desktop_clipboard: clipboard,
			desktop_interaction: {
				selected,
				pressed,
				select: (paths) => {
					calls.push(["select", paths])
					set_selected(paths)
				},
				press: set_pressed,
				redraw: record("redraw"),
				rename: {
					path: rename_path,
					cancel: record("rename.cancel"),
					commit: record("rename.commit"),
					begin: record("rename.begin"),
				},
			},
			remove_desktop_files: record("remove", settle_task),
			cancel_desktop_cut: record("cancel_cut", settle_task),
			paste_desktop_files: record("paste", settle_task),
			copy_desktop_files: record("copy"),
			cut_desktop_files: record("cut"),
			open_desktop_files: record("open"),
		},
	}
	const original_error = console.error
	const module = await load_module(
		"widget/Desktop/components/Grid.tsx",
		imports,
	)
	const window_controllers: any[] = []
	module.attach_desktop_keyboard(
		{ add_controller: (c) => window_controllers.push(c) },
		grid,
	)
	const keyboard = window_controllers[0]
	const drag = {
		state: drag_state,
		track: record("track"),
		leave: record("leave"),
		attach_target: record("attach_target"),
	}
	const geometry_state = make_accessor(() => ({ width: 300, height: 700 }))
	const tree = module.DesktopGrid({
		monitor: "gdk-monitor",
		geometry: geometry_state,
		grid,
		drag,
	})
	const settle = async () => {
		for (let i = 0; i < 4; i++) await new Promise(setImmediate)
	}
	return {
		calls,
		errors,
		icons,
		tree,
		grid,
		set_grid,
		set_enabled,
		set_clipboard,
		set_drag_state,
		set_rename_path,
		set_pressed,
		Entry,
		Widget,
		cleanups,
		selected,
		select: set_selected,
		set_now: (value: number) => {
			now = value
		},
		fail_tasks: (error: unknown) => {
			failure = error
		},
		press: (key: number, modifiers = 0) =>
			keyboard.handlers.get("key-pressed")(keyboard, key, 0, modifiers),
		release: (key: number) =>
			keyboard.handlers.get("key-released")(keyboard, key),
		capture: async (run: () => unknown) => {
			console.error = (...args) => {
				if (String(args[0]).startsWith("desktop.")) errors.push(args)
				else original_error(...args)
			}
			try {
				run()
				await settle()
			} finally {
				console.error = original_error
			}
		},
		find: (type, props: Record<string, unknown> = {}) =>
			nodes(tree).filter(
				(node) =>
					node.type === type &&
					Object.entries(props).every(
						([key, value]) => node.props[key] === value,
					),
			),
	}
}

test("keyboard shortcuts act on the selection and report failed async actions", async () => {
	const f = await fixture()
	assert.deepEqual(f.calls.shift(), [
		"key_controller",
		{ propagation_phase: 1 },
	])
	assert.equal(f.press(keys.KEY_Shift_L), false)
	f.release(keys.KEY_Shift_R)
	f.release(keys.KEY_a)
	assert.deepEqual(f.calls.splice(0), [
		["set_shift_held", true],
		["set_shift_held", false],
	])
	f.select(["/d/two"])
	assert.equal(f.press(keys.KEY_Escape), true)
	assert.equal(f.press(keys.KEY_Delete, shift), true)
	assert.equal(f.press(keys.KEY_Delete), true)
	assert.equal(f.press(keys.KEY_A, control), true)
	assert.equal(f.press(keys.KEY_c, control), true)
	assert.equal(f.press(keys.KEY_X, control), true)
	f.select([])
	assert.equal(f.press(keys.KEY_x, control), true)
	assert.equal(f.press(keys.KEY_V, control), true)
	assert.equal(f.press(keys.KEY_a), false)
	assert.equal(f.press(99999), false)
	assert.equal(f.press(99999, control), false)
	assert.equal(f.press(keys.KEY_Escape, control), true)
	assert.deepEqual(f.calls.splice(0), [
		["hide"],
		["remove", ["/d/two"], { permanently: true }],
		["remove", ["/d/two"], { permanently: false }],
		["select", ["/d/one", "/d/two", "/d/three"]],
		["copy", ["/d/one", "/d/two", "/d/three"]],
		["cut", ["/d/one", "/d/two", "/d/three"]],
		["cancel_cut"],
		["paste", "monitor:a"],
		["hide"],
	])
	f.fail_tasks(new Error("busy"))
	await f.capture(() => {
		f.select(["/d/one"])
		f.press(keys.KEY_Delete)
		f.select([])
		f.press(keys.KEY_x, control)
		f.press(keys.KEY_v, control)
	})
	assert.deepEqual(
		f.errors.map(([tag, error]) => [tag, (error as Error).message]),
		[
			["desktop.keyboard: Failed to remove files", "busy"],
			["desktop.keyboard: Failed to cancel cut", "busy"],
			["desktop.keyboard: Failed to paste files", "busy"],
		],
	)
})

test("Tab, Return and F2 step, open and rename a single selection", async () => {
	const f = await fixture()
	f.calls.splice(0)
	f.select(["/d/one"])
	assert.equal(f.press(keys.KEY_Tab), true)
	assert.deepEqual(f.selected.peek(), ["/d/two"])
	assert.equal(f.press(keys.KEY_Tab, shift), true)
	assert.deepEqual(f.selected.peek(), ["/d/one"])
	assert.equal(f.press(keys.KEY_ISO_Left_Tab), true)
	assert.deepEqual(f.selected.peek(), ["/d/three"])
	assert.equal(f.press(keys.KEY_Return), true)
	assert.equal(f.press(keys.KEY_F2), true)
	f.select(["/d/one", "/d/two"])
	assert.equal(f.press(keys.KEY_Return), true)
	assert.equal(f.press(keys.KEY_F2), true)
	assert.deepEqual(
		f.calls.filter(([name]) => name !== "select"),
		[
			["open", ["/d/three"]],
			["rename.begin", "/d/three"],
		],
	)
	f.set_grid({ ...f.grid.peek(), files: [] })
	f.select([])
	f.calls.splice(0)
	assert.equal(f.press(keys.KEY_Tab), true)
	assert.deepEqual(f.calls, [])
})

test("rename and disabled desktop limit the keyboard", async () => {
	const f = await fixture()
	f.calls.splice(0)
	f.set_rename_path("/d/one")
	assert.equal(f.press(keys.KEY_Delete), false)
	assert.equal(f.press(keys.KEY_Escape), true)
	assert.deepEqual(f.calls.splice(0), [["rename.cancel"]])
	f.set_rename_path(null)
	f.set_enabled(false)
	assert.equal(f.press(keys.KEY_Escape), false)
	assert.equal(f.press(keys.KEY_Shift_L), false)
	assert.deepEqual(f.calls, [["set_shift_held", true]])
})

function gesture({
	picked = null as unknown,
	modifiers = 0,
	root = null as unknown,
	translated = true,
} = {}) {
	const widget = {
		pick: () => picked,
		get_root: () => root,
		translate_coordinates: (_root, x, y) => [translated, x + 100, y + 200],
	}
	return {
		resets: 0,
		get_widget: () => widget,
		get_current_event_state: () => modifiers,
		reset() {
			this.resets++
		},
	}
}

test("clicks on empty desktop clear selection, commit renames and open the context menu", async () => {
	const f = await fixture()
	const [left] = f.find("GestureClick", { button: primary })
	const [right] = f.find("GestureClick", { button: secondary })
	f.calls.splice(0)
	f.select(["/d/one"])
	const icon = {
		get_parent: () => null,
		has_css_class: (name) => name === "desktop-icon",
	}
	const label = { get_parent: () => icon, has_css_class: () => false }
	left.props.onPressed(gesture({ picked: label }), 1, 5, 5)
	left.props.onPressed(gesture({ picked: new f.Entry() }), 1, 5, 5)
	right.props.onPressed(gesture({ picked: label }), 1, 5, 5)
	assert.deepEqual(f.calls.splice(0), [])
	left.props.onPressed(gesture(), 1, 5, 5)
	assert.deepEqual(f.calls.splice(0), [["select", []], ["hide"]])
	f.set_rename_path("/d/one")
	left.props.onPressed(gesture(), 1, 5, 5)
	assert.deepEqual(f.calls.splice(0), [["rename.commit"]])
	right.props.onPressed(
		gesture({ modifiers: shift, root: new f.Widget() }),
		1,
		5,
		6,
	)
	right.props.onPressed(gesture({ root: {} }), 1, 7, 8)
	right.props.onPressed(
		gesture({ root: new f.Widget(), translated: false }),
		1,
		9,
		4,
	)
	assert.deepEqual(f.calls.splice(0), [
		["rename.commit"],
		["select", []],
		[
			"show",
			{
				monitor: "gdk-monitor",
				monitor_id: "monitor:a",
				x: 105,
				y: 206,
				shift: true,
			},
		],
		["rename.commit"],
		["select", []],
		[
			"show",
			{
				monitor: "gdk-monitor",
				monitor_id: "monitor:a",
				x: 7,
				y: 8,
				shift: false,
			},
		],
		["rename.commit"],
		["select", []],
		[
			"show",
			{
				monitor: "gdk-monitor",
				monitor_id: "monitor:a",
				x: 9,
				y: 4,
				shift: false,
			},
		],
	])
	f.set_enabled(false)
	left.props.onPressed(gesture(), 1, 5, 5)
	right.props.onPressed(gesture(), 1, 5, 5)
	assert.deepEqual(f.calls, [])
})

test("rubber band selection is throttled, finalized past 5px and hidden afterwards", async () => {
	const f = await fixture()
	const [band] = f.find("GestureDrag")
	const [box] = f.find("box", { class: "selection-rectangle" })
	f.calls.splice(0)
	f.set_pressed("/d/one")
	const busy = gesture()
	band.props.onDragBegin(busy, 1, 1)
	assert.equal(busy.resets, 1)
	f.set_pressed(null)
	assert.equal(box.props.visible(), false)
	band.props.onDragUpdate(gesture(), 4, 4)
	assert.deepEqual(f.calls.splice(0), [])
	band.props.onDragBegin(gesture(), 12, 3)
	assert.equal(box.props.visible(), true)
	assert.deepEqual(f.calls.splice(0), [["hide"], ["select", ["/d/two"]]])
	f.set_now(10_000)
	band.props.onDragUpdate(gesture(), -4, 9)
	assert.deepEqual(
		[
			box.props.marginStart(),
			box.props.marginTop(),
			box.props.widthRequest(),
			box.props.heightRequest(),
		],
		[8, 3, 4, 9],
	)
	assert.deepEqual(f.calls.splice(0), [])
	f.set_now(16_000)
	band.props.onDragUpdate(gesture(), -4, 9)
	assert.deepEqual(f.calls.splice(0), [
		["select", ["/d/one", "/d/two", "/d/three"]],
	])
	f.set_now(20_000)
	band.props.onDragUpdate(gesture(), -12, 0)
	assert.deepEqual(f.calls.splice(0), [])
	f.set_now(32_000)
	band.props.onDragUpdate(gesture(), -12, 0)
	assert.deepEqual(f.calls.splice(0), [["select", ["/d/one", "/d/two"]]])
	f.set_now(40_000)
	band.props.onDragUpdate(gesture(), -12, 0)
	band.props.onDragEnd(gesture(), 3, 4)
	assert.deepEqual(f.calls.splice(0), [["redraw"]])
	assert.equal(box.props.visible(), false)
	assert.deepEqual(
		[box.props.widthRequest(), box.props.heightRequest()],
		[0, 0],
	)
	band.props.onDragBegin(gesture(), 12, 3)
	band.props.onDragUpdate(gesture(), 0, 9)
	assert.deepEqual(f.calls.splice(0), [
		["hide"],
		["select", ["/d/two"]],
		["select", ["/d/two", "/d/three"]],
	])
	band.props.onDragEnd(gesture(), 0, 0)
	band.props.onDragBegin(gesture(), 12, 3)
	f.calls.splice(0)
	band.props.onDragEnd(gesture(), -5, 5)
	assert.deepEqual(f.calls.splice(0), [["redraw"]])
	band.props.onDragBegin(gesture(), 12, 3)
	f.calls.splice(0)
	band.props.onDragEnd(gesture(), -6, 0)
	assert.deepEqual(f.calls.splice(0), [
		["select", ["/d/one", "/d/two"]],
		["redraw"],
	])
	band.props.onDragBegin(gesture(), 12, 3)
	f.calls.splice(0)
	band.props.onDragEnd(gesture(), 0, 9)
	assert.deepEqual(f.calls.splice(0), [
		["select", ["/d/two", "/d/three"]],
		["redraw"],
	])
	f.set_enabled(false)
	band.props.onDragBegin(gesture(), 0, 0)
	assert.deepEqual(f.calls, [])
})

test("icons are laid out on their slots and follow slot changes", async () => {
	const f = await fixture()
	const [fixed] = f.find("Fixed")
	const [overlay] = f.find("overlay")
	assert.equal(overlay.props.heightRequest(), 25)
	f.set_grid({ ...f.grid.peek(), metrics: null })
	assert.equal(overlay.props.heightRequest(), 700)
	f.set_grid({
		...f.grid.peek(),
		metrics: { ...(f.grid.peek().metrics ?? {}) },
	})
	const [list] = f.find("For")
	const moves: unknown[][] = []
	const widget = (name: string) => ({
		set_size_request: (w, h) => moves.push([name, "size", w, h]),
	})
	const one = widget("one")
	const loose = widget("loose")
	const render = (file) => list.props.children(file)
	render({ path: "/d/one" })
	const props = f.icons[0]
	props.register_widget("/d/one", one)
	assert.equal(moves.length, 0)
	f.set_grid({
		id: "monitor:a",
		metrics: {
			cell_width: 10,
			cell_height: 10,
			rows: 2,
			columns: 3,
			offset_x: 0,
			offset_y: 0,
			padding_right: 0,
			padding_bottom: 5,
		},
		files: [{ path: "/d/one" }, { path: "/d/two" }],
		positions: { "/d/one": 0, "/d/two": 1 },
	})
	const container = {
		move: (w, x, y) => moves.push([w === one ? "one" : "other", "move", x, y]),
	}
	fixed.props.$(container)
	assert.deepEqual(moves.splice(0), [
		["one", "size", 10, 10],
		["one", "move", 0, 0],
	])
	props.register_widget("/d/loose", loose)
	assert.deepEqual(moves.splice(0), [])
	props.register_widget("/d/two", widget("two"))
	assert.deepEqual(moves.splice(0), [
		["two", "size", 10, 10],
		["other", "move", 10, 0],
	])
	f.set_grid({ ...f.grid.peek(), positions: { "/d/one": 4, "/d/two": 1 } })
	assert.deepEqual(moves.splice(0), [
		["one", "size", 10, 10],
		["one", "move", 10, 10],
		["two", "size", 10, 10],
		["other", "move", 10, 0],
	])
	props.unregister_widget("/d/one", widget("stale"))
	props.unregister_widget("/d/two", loose)
	f.set_grid({ ...f.grid.peek(), positions: { "/d/one": 5 } })
	assert.deepEqual(moves.splice(0), [
		["one", "size", 10, 10],
		["one", "move", 20, 10],
	])
	for (const cleanup of f.cleanups) cleanup()
	props.register_widget("/d/one", one)
	f.set_grid({ ...f.grid.peek(), positions: { "/d/one": 0 } })
	assert.deepEqual(moves, [])
	assert.equal(
		list.props.id({ path: "/p", icon: "i", content_type: "t" }),
		"/p\0\0i\0\0t\x000",
	)
	assert.equal(
		list.props.id({
			path: "/p",
			display_name: "D",
			icon: "i",
			icon_file: "f",
			content_type: "t",
			modified: new Date(5),
		}),
		"/p\0D\0i\0f\0t\x005",
	)
})

test("selected, dragged and cut path sets reuse one empty set", async () => {
	const f = await fixture()
	const [list] = f.find("For")
	list.props.children({ path: "/d/one" })
	const props = f.icons[0]
	assert.equal(props.selected_paths(), props.dragged_paths())
	assert.equal(props.cut_paths(), props.dragged_paths())
	f.select(["/d/one"])
	f.set_drag_state({ paths: ["/d/two"] })
	f.set_clipboard({ operation: "copy", paths: ["/d/one"] })
	assert.deepEqual([...props.selected_paths()], ["/d/one"])
	assert.deepEqual([...props.dragged_paths()], ["/d/two"])
	assert.equal(props.cut_paths().size, 0)
	f.set_clipboard({ operation: "cut", paths: [] })
	assert.equal(props.cut_paths().size, 0)
	f.set_clipboard({ operation: "cut", paths: ["/d/one"] })
	assert.deepEqual([...props.cut_paths()], ["/d/one"])
	assert.equal(props.monitor_id(), "monitor:a")
	assert.equal(props.icon_metrics().icon_px, 56)
})
