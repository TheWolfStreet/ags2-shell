import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as result_module from "../../lib/result.ts"
import {
	accessor,
	push_idle,
	create_state,
	jsx_runtime,
	nodes,
	read,
	tick,
	type node,
} from "../helpers.ts"

async function context_menu_fixture() {
	let selected: string[] = []
	let enabled = true
	let open_behaviour = "ok"
	const calls: unknown[][] = []
	const idles: (() => void)[] = []
	const timeouts: { ms: number; run: () => void }[] = []
	const errors: unknown[][] = []
	const entries = new Map<string, string | null>()
	const files = new Map<string, { content_type: string }>()
	const imports = {
		ags: {
			Accessor: class {},
			createState: create_state,
			createComputed: accessor,
			onCleanup: () => {},
		},
		"ags/gtk4": {
			Astal: {
				WindowAnchor: { TOP: 1, LEFT: 4 },
				Layer: { TOP: 2 },
				Exclusivity: { IGNORE: 0 },
				Keymode: { ON_DEMAND: 2 },
			},
			Gdk: { KEY_Escape: 27, KEY_Shift_L: 50, KEY_Shift_R: 62 },
			Gtk: {
				Align: { START: 1, END: 2, CENTER: 3, FILL: 0 },
				Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
				Separator: "separator",
				EventControllerKey: "keys",
				EventControllerMotion: "motion",
				GestureClick: "click",
			},
		},
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"$lib/time": {
			idle: push_idle(idles),
			timeout: (ms, run) => timeouts.push({ ms, run }),
		},
		"gi://Graphene": {
			default: {
				Point: class {
					declare x: number
					declare y: number
					constructor({ x, y }) {
						this.x = x
						this.y = y
					}
				},
			},
		},
		"$lib/result": result_module,
		"$lib/windowing": {
			schedule_monitor_window_release: (window) =>
				calls.push(["release", window]),
		},
		"$shell/options": {
			default: {
				desktop: {
					enabled: Object.assign(() => enabled, { peek: () => enabled }),
				},
			},
		},
		"../desktop": {
			copy_desktop_files: (paths) => calls.push(["copy", paths]),
			cut_desktop_files: (paths) => calls.push(["cut", paths]),
			open_desktop_files: (paths) => {
				calls.push(["open", paths])
				if (open_behaviour === "throw") throw new Error("boom")
				if (open_behaviour === "reject")
					return Promise.reject(new Error("later"))
				if (open_behaviour === "resolve") return Promise.resolve()
			},
			paste_desktop_files: (id) => calls.push(["paste", id]),
			remove_desktop_files: (paths, options) =>
				calls.push(["remove", paths, options]),
			create_desktop_entry: (id, options) => {
				calls.push(["create", id, options])
				return entries.get(options.kind) ?? null
			},
			desktop_file_by_path: (path) => files.get(path) ?? null,
			desktop_interaction: {
				selected: accessor(() => selected),
				rename: { begin: (path) => calls.push(["rename", path]) },
			},
		},
		"../file_operations": { directory_type: "inode/directory" },
		"./LauncherCreator": {
			DesktopLauncherCreator: {
				open: (id) => calls.push(["launcher", id]),
			},
		},
		"./OpenWith": {
			DesktopOpenWith: { open: (path) => calls.push(["open_with", path]) },
		},
	}
	const module = await load_module(
		"widget/Desktop/components/ContextMenu.tsx",
		imports,
	)
	const monitor = { name: "eDP-1" }
	const window_tree: node = module.DesktopContextMenu({ gdkmonitor: monitor })
	const buttons = nodes(window_tree, "button")
	const button = (label: string) => {
		const found = buttons.find((item) => {
			const [text] = nodes(item, "label")
			return read(text.props.label) === label
		})
		assert.ok(found, `no ${label} button`)
		return found
	}
	const controller = (type: string) => nodes(window_tree, type)[0]
	return {
		menu: module.desktop_context_menu,
		window_tree,
		monitor,
		calls,
		idles,
		timeouts,
		errors,
		entries,
		files,
		buttons,
		button,
		controller,
		select: (paths: string[]) => {
			selected = paths
		},
		set_enabled: (value: boolean) => {
			enabled = value
		},
		set_open_behaviour: (value: string) => {
			open_behaviour = value
		},
	}
}

function labels_of(button: node) {
	return nodes(button, "label").map((item) => [
		read(item.props.label),
		read(item.props.visible),
	])
}

test("show is ignored while the desktop is disabled and hide clears every field", async () => {
	const fixture = await context_menu_fixture()
	const { menu, monitor } = fixture
	fixture.set_enabled(false)
	menu.show({ monitor, monitor_id: "m1", x: 3, y: 4 })
	assert.equal(menu.visible.peek(), false)
	fixture.set_enabled(true)
	menu.show({ monitor, monitor_id: "m1", x: 3, y: 4, shift: true })
	assert.deepEqual(
		[
			menu.visible.peek(),
			menu.monitor.peek(),
			menu.monitor_id.peek(),
			menu.position.peek(),
			menu.shift_held.peek(),
		],
		[true, monitor, "m1", { x: 3, y: 4 }, true],
	)
	assert.equal(read(fixture.window_tree.props.visible), true)
	assert.equal(read(fixture.window_tree.props.marginLeft), 3)
	assert.equal(read(fixture.window_tree.props.marginTop), 4)
	menu.hide()
	assert.deepEqual(
		[
			menu.visible.peek(),
			menu.monitor.peek(),
			menu.monitor_id.peek(),
			menu.shift_held.peek(),
		],
		[false, null, null, false],
	)
})

test("menu entries follow the selection and run their actions", async () => {
	const fixture = await context_menu_fixture()
	const { button, calls, files, menu, monitor } = fixture
	const visible = () =>
		fixture.buttons
			.filter((item) => read(item.props.visible))
			.map((item) => labels_of(item)[0][0])
	fixture.select([])
	assert.deepEqual(visible(), [
		"Paste",
		"New Launcher",
		"New Folder",
		"New Text File",
	])
	fixture.select(["/d/folder"])
	files.set("/d/folder", { content_type: "inode/directory" })
	assert.deepEqual(visible(), [
		"Open",
		"Rename",
		"Cut",
		"Copy",
		"Paste",
		"Move to Trash",
	])
	fixture.select(["/d/a.txt"])
	files.set("/d/a.txt", { content_type: "text/plain" })
	assert.ok(visible().includes("Open With…"))
	fixture.select(["/d/a", "/d/b"])
	assert.deepEqual(visible(), ["Cut", "Copy", "Paste", "Move to Trash"])

	menu.show({ monitor, monitor_id: "m7", x: 0, y: 0 })
	fixture.select(["/d/a.txt"])
	for (const label of [
		"Open",
		"Open With…",
		"Rename",
		"Cut",
		"Copy",
		"Paste",
		"Move to Trash",
		"New Launcher",
	])
		button(label).props.onClicked()
	assert.deepEqual(calls, [
		["open", ["/d/a.txt"]],
		["open_with", "/d/a.txt"],
		["rename", "/d/a.txt"],
		["cut", ["/d/a.txt"]],
		["copy", ["/d/a.txt"]],
		["paste", "monitor:default"],
		["remove", ["/d/a.txt"], { permanently: false }],
		["launcher", "monitor:default"],
	])
})

test("an empty selection makes open-with and rename do nothing and paste uses the monitor id", async () => {
	const fixture = await context_menu_fixture()
	const { button, calls, menu, monitor } = fixture
	fixture.select([])
	button("Open With…").props.onClicked()
	button("Rename").props.onClicked()
	assert.deepEqual(calls, [])
	menu.show({ monitor, monitor_id: "m7", x: 0, y: 0 })
	button("Paste").props.onClicked()
	assert.deepEqual(calls, [["paste", "m7"]])
	assert.equal(menu.visible.peek(), false)
})

test("shift switches removal to permanent with its own label and shortcut", async () => {
	const fixture = await context_menu_fixture()
	const { calls, menu, monitor } = fixture
	fixture.select(["/d/a"])
	menu.show({ monitor, monitor_id: "m1", x: 0, y: 0, shift: true })
	const remove = fixture.button("Delete Immediately")
	assert.deepEqual(labels_of(remove), [
		["Delete Immediately", undefined],
		["⇧⌫", true],
	])
	remove.props.onClicked()
	assert.deepEqual(calls, [["remove", ["/d/a"], { permanently: true }]])
	assert.deepEqual(labels_of(fixture.button("Paste")), [
		["Paste", undefined],
		["Ctrl+V", true],
	])
	assert.deepEqual(labels_of(fixture.button("New Folder"))[1], ["", false])
})

test("new folder and text file rename the created entry once the menu has hidden", async () => {
	const fixture = await context_menu_fixture()
	const { button, calls, entries, idles, menu, monitor } = fixture
	fixture.select([])
	button("New Folder").props.onClicked()
	button("New Text File").props.onClicked()
	assert.deepEqual(calls, [
		["create", "monitor:default", { kind: "folder" }],
		["create", "monitor:default", { kind: "file" }],
	])
	assert.equal(idles.length, 0)
	calls.length = 0

	entries.set("folder", "/d/New Folder")
	entries.set("file", "/d/New Text File.txt")
	menu.show({ monitor, monitor_id: "m2", x: 0, y: 0 })
	button("New Folder").props.onClicked()
	menu.show({ monitor, monitor_id: "m2", x: 0, y: 0 })
	button("New Text File").props.onClicked()
	assert.equal(idles.length, 2)
	for (const run of idles) run()
	assert.deepEqual(calls, [
		["create", "m2", { kind: "folder" }],
		["create", "m2", { kind: "file" }],
		["rename", "/d/New Folder"],
		["rename", "/d/New Text File.txt"],
	])
})

test("hide_then waits for a visible menu window to unmap before running", async () => {
	const fixture = await context_menu_fixture()
	const { menu, monitor, idles } = fixture
	const order: string[] = []
	menu.hide_then(() => order.push("no window"))
	assert.equal(idles.length, 1)

	let visible = true
	let handler_run: ((self) => void) | null = null
	const disconnected: number[] = []
	const window = {
		get_visible: () => visible,
		connect: (signal, run) => {
			assert.equal(signal, "notify::visible")
			handler_run = run
			return 41
		},
		disconnect: (id) => disconnected.push(id),
	}
	fixture.window_tree.props.$(window)
	menu.show({ monitor, monitor_id: "m1", x: 0, y: 0 })
	menu.hide_then(() => order.push("after unmap"))
	assert.equal(menu.visible.peek(), false)
	assert.equal(idles.length, 1)
	handler_run!(window)
	assert.deepEqual(disconnected, [])
	visible = false
	handler_run!(window)
	assert.deepEqual(disconnected, [41])
	for (const run of idles) run()
	assert.deepEqual(order, ["no window", "after unmap"])

	menu.show({ monitor, monitor_id: "m1", x: 0, y: 0 })
	menu.hide_then(() => order.push("hidden window"))
	assert.equal(idles.length, 3)
})

test("leaving hides after 100ms only when the pointer is outside both surfaces", async () => {
	const fixture = await context_menu_fixture()
	const { menu, monitor, timeouts } = fixture
	menu.show({ monitor, monitor_id: "m1", x: 0, y: 0 })
	menu.enter_desktop()
	menu.leave_menu()
	assert.deepEqual(
		timeouts.map((entry) => entry.ms),
		[100],
	)
	timeouts[0].run()
	assert.equal(menu.visible.peek(), true)
	menu.leave_desktop()
	menu.enter_menu()
	timeouts[1].run()
	assert.equal(menu.visible.peek(), true)
	menu.leave_menu()
	timeouts[2].run()
	assert.equal(menu.visible.peek(), false)
	const motion = fixture.controller("motion")
	assert.equal(motion.props.onEnter, menu.enter_menu)
	assert.equal(motion.props.onLeave, menu.leave_menu)
})

test("shift keys track the shift state and escape hides the menu", async () => {
	const fixture = await context_menu_fixture()
	const { menu, monitor } = fixture
	const keys = fixture.controller("keys").props
	menu.show({ monitor, monitor_id: "m1", x: 0, y: 0 })
	assert.equal(keys.onKeyPressed(null, 50), false)
	assert.equal(menu.shift_held.peek(), true)
	assert.equal(keys.onKeyReleased(null, 62), false)
	assert.equal(menu.shift_held.peek(), false)
	assert.equal(keys.onKeyPressed(null, 62), false)
	assert.equal(menu.shift_held.peek(), true)
	assert.equal(keys.onKeyReleased(null, 50), false)
	assert.equal(menu.shift_held.peek(), false)
	assert.equal(keys.onKeyPressed(null, 65), false)
	assert.equal(keys.onKeyReleased(null, 65), false)
	assert.equal(menu.visible.peek(), true)
	assert.equal(keys.onKeyPressed(null, 27), true)
	assert.equal(menu.visible.peek(), false)
})

test("clicks outside the menu content hide it", async () => {
	const fixture = await context_menu_fixture()
	const { menu, monitor } = fixture
	const click = fixture.controller("click").props
	const content_tree = nodes(fixture.window_tree).find(
		(item) => item.props.class === "contents",
	)
	const widget = {}
	const controller = { get_widget: () => widget }
	const show = () => menu.show({ monitor, monitor_id: "m1", x: 0, y: 0 })

	show()
	click.onPressed(controller, 1, 5, 5)
	assert.equal(menu.visible.peek(), false)

	let computed = true
	content_tree.props.$({
		compute_bounds: (target) => {
			assert.equal(target, widget)
			return [
				computed,
				{ contains_point: (point) => point.x < 10 && point.y < 10 },
			]
		},
	})
	show()
	click.onPressed(controller, 1, 5, 5)
	assert.equal(menu.visible.peek(), true)
	click.onPressed(controller, 1, 50, 5)
	assert.equal(menu.visible.peek(), false)
	show()
	computed = false
	click.onPressed(controller, 1, 5, 5)
	assert.equal(menu.visible.peek(), false)
	show()
	click.onPressed({ get_widget: () => null }, 1, 5, 5)
	assert.equal(menu.visible.peek(), false)
})

test("failing actions are logged with the menu tag after the menu hides", async (t) => {
	const fixture = await context_menu_fixture()
	const { menu, monitor } = fixture
	const logged: unknown[][] = []
	t.mock.method(console, "error", (tag, error) => {
		if (String(tag).startsWith("desktop."))
			logged.push([tag, String(error), menu.visible.peek()])
	})
	fixture.select(["/d/a"])
	const open = fixture.button("Open")
	for (const behaviour of ["throw", "reject", "resolve", "ok"]) {
		fixture.set_open_behaviour(behaviour)
		menu.show({ monitor, monitor_id: "m1", x: 0, y: 0 })
		open.props.onClicked()
		assert.equal(menu.visible.peek(), false)
	}
	assert.deepEqual(logged, [
		["desktop.menu: Action failed", "Error: boom", false],
	])
	await tick()
	assert.deepEqual(logged, [
		["desktop.menu: Action failed", "Error: boom", false],
		["desktop.menu: Action failed", "Error: later", false],
	])
})
