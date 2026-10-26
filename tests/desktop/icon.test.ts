import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as icons from "../../lib/icons.ts"
import {
	nodes,
	state_scope,
	make_flat as make,
	immediate_idle,
} from "../helpers.ts"

const primary = 1
const secondary = 3
const control = 4
const shift = 1

async function fixture(file: Record<string, unknown> = {}) {
	const { make_accessor, state } = state_scope()
	const calls: unknown[][] = []
	const record =
		(name: string) =>
		(...args) =>
			calls.push([name, ...args])
	const [selected, set_selected] = state<string[]>([])
	const [rename_path, set_rename_path] = state<string | null>(null)
	const [rename_value] = state("renamed")
	const [drag_state, set_drag_state] = state<{ paths: string[] }>({ paths: [] })
	const [metrics, set_metrics] = state({
		icon_px: 56,
		cell_px: 100,
		label_chars: 9,
	})
	const [selected_paths, set_selected_paths] = state(new Set<string>())
	const [dragged_paths, set_dragged_paths] = state(new Set<string>())
	const [cut_paths, set_cut_paths] = state(new Set<string>())
	const imports = {
		ags: {
			createComputed: (fn) => make_accessor(fn),
			onCleanup: record("cleanup"),
		},
		"ags/gtk4": {
			Gdk: {
				BUTTON_PRIMARY: primary,
				BUTTON_SECONDARY: secondary,
				ModifierType: { CONTROL_MASK: control, SHIFT_MASK: shift },
			},
			Gtk: {
				Align: { START: 0, CENTER: 1, FILL: 2, END: 3 },
				Orientation: { VERTICAL: 1 },
				ContentFit: { COVER: 2 },
				Overflow: { HIDDEN: 1 },
				Window: class {},
				Picture: "Picture",
				Text: "Text",
				GestureClick: "GestureClick",
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"$lib/time": { idle: immediate_idle },
		"$lib/textures": {
			hidden_drag_icon: () => "hidden",
			create_texture_accessor: (path, size) => () => `${path}@${size}`,
		},
		"./ContextMenu": {
			desktop_context_menu: { hide: record("hide"), show: record("show") },
		},
		"../desktop": {
			desktop_interaction: {
				selected,
				select: (paths) => {
					calls.push(["select", paths])
					set_selected(paths)
				},
				press: record("press"),
				rename: {
					path: rename_path,
					value: rename_value,
					set_value: record("rename.set_value"),
					commit: record("rename.commit"),
				},
			},
			open_desktop_files: record("open"),
		},
	}
	const module = await load_module(
		"widget/Desktop/components/Icon.tsx",
		imports,
	)
	const desktop_file = {
		path: "/d/notes.txt",
		name: "notes.txt",
		icon: "text-x-generic",
		content_type: "text/plain",
		...file,
	}
	let begin_drag = () => {}
	const tree = module.DesktopIcon({
		file: desktop_file,
		monitor: "gdk-monitor",
		monitor_id: make_accessor(() => "monitor:a"),
		drag: {
			state: drag_state,
			attach_source: (_widget, path, on_begin) => {
				calls.push(["attach_source", path])
				begin_drag = on_begin
			},
		},
		icon_metrics: metrics,
		selected_paths,
		dragged_paths,
		cut_paths,
		register_widget: record("register"),
		unregister_widget: record("unregister"),
	})
	tree.props.$("root-widget")
	calls.splice(0)
	const [click] = nodes(tree, "GestureClick")
	const gesture = (
		button: number,
		modifiers = 0,
		position: unknown = [true, 30, 40],
	) => ({
		get_current_button: () => button,
		get_current_event_state: () => modifiers,
		get_current_event: () =>
			position ? { get_position: () => position } : null,
	})
	return {
		tree,
		calls,
		selected,
		select: set_selected,
		set_rename_path,
		set_drag_state,
		set_metrics,
		set_selected_paths,
		set_dragged_paths,
		set_cut_paths,
		begin_drag: () => begin_drag(),
		press: (button: number, count = 1, modifiers = 0, position?: unknown) =>
			click.props.onPressed(gesture(button, modifiers, position), count),
		release: (button: number) => click.props.onReleased(gesture(button)),
		find: (matches: (node) => boolean) => nodes(tree).filter(matches),
	}
}

test("icon classes follow selection, drag and drag-pack membership", async () => {
	const f = await fixture()
	assert.equal(f.tree.props.class(), "desktop-icon")
	f.set_selected_paths(new Set(["/d/notes.txt"]))
	assert.equal(f.tree.props.class(), "desktop-icon selected")
	f.set_drag_state({ paths: ["/d/notes.txt"] })
	f.set_dragged_paths(new Set(["/d/notes.txt"]))
	assert.equal(f.tree.props.class(), "desktop-icon selected dragging")
	f.set_dragged_paths(new Set(["/d/notes.txt", "/d/other"]))
	assert.equal(f.tree.props.class(), "desktop-icon selected dragging drag-pack")
	f.set_selected_paths(new Set())
	f.set_drag_state({ paths: [] })
	assert.equal(f.tree.props.class(), "desktop-icon drag-pack")
})

test("primary clicks select, toggle with Ctrl, defer inside a group and open on double click", async () => {
	const f = await fixture()
	f.press(primary)
	f.release(primary)
	assert.deepEqual(f.calls.splice(0), [
		["press", "/d/notes.txt"],
		["hide"],
		["select", ["/d/notes.txt"]],
		["press", null],
	])
	f.press(primary, 1, control)
	assert.deepEqual(f.selected.peek(), [])
	f.press(primary, 1, control)
	assert.deepEqual(f.selected.peek(), ["/d/notes.txt"])
	f.select(["/d/other", "/d/notes.txt"])
	f.calls.splice(0)
	f.press(primary)
	assert.deepEqual(f.calls.splice(0), [["press", "/d/notes.txt"], ["hide"]])
	f.release(primary)
	assert.deepEqual(f.calls.splice(0), [
		["select", ["/d/notes.txt"]],
		["press", null],
	])
	f.select(["/d/other", "/d/notes.txt"])
	f.calls.splice(0)
	f.press(primary)
	f.begin_drag()
	f.release(primary)
	assert.deepEqual(f.calls.splice(0), [
		["press", "/d/notes.txt"],
		["hide"],
		["press", null],
	])
	f.select(["/d/other", "/d/notes.txt"])
	f.press(primary)
	f.release(primary)
	assert.deepEqual(f.selected.peek(), ["/d/notes.txt"])
	f.select(["/d/other"])
	f.press(primary, 2)
	assert.deepEqual(f.calls.splice(0).at(-1), ["open", ["/d/notes.txt"]])
	f.release(secondary)
	assert.deepEqual(f.calls, [])
})

test("secondary clicks keep a group selection and open the menu at the event point", async () => {
	const f = await fixture()
	f.press(secondary, 1, shift)
	assert.deepEqual(f.calls.splice(0), [
		["select", ["/d/notes.txt"]],
		[
			"show",
			{
				monitor: "gdk-monitor",
				monitor_id: "monitor:a",
				x: 30,
				y: 40,
				shift: true,
			},
		],
	])
	f.select(["/d/a", "/d/notes.txt"])
	f.calls.splice(0)
	f.press(secondary, 2)
	f.press(secondary, 1, 0, [false, 1, 1])
	f.press(secondary, 1, 0, null)
	assert.deepEqual(f.calls.splice(0), [
		[
			"show",
			{
				monitor: "gdk-monitor",
				monitor_id: "monitor:a",
				x: 30,
				y: 40,
				shift: false,
			},
		],
	])
	f.press(2)
	assert.deepEqual(f.calls, [])
})

test("pressing commits another icon's rename and ignores presses on the icon being renamed", async () => {
	const f = await fixture()
	f.set_rename_path("/d/notes.txt")
	f.press(primary)
	assert.deepEqual(f.calls.splice(0), [])
	f.set_rename_path("/d/other")
	f.press(primary)
	assert.deepEqual(f.calls.splice(0, 2), [
		["rename.commit"],
		["press", "/d/notes.txt"],
	])
})

test("labels truncate to the icon size and show the full name as tooltip", async () => {
	const f = await fixture({
		name: "a-very-long-name.txt",
		display_name: "Ünïcödé long label",
	})
	const [label] = f.find(
		(node) => node.type === "box" && node.props.class === "desktop-icon-label",
	)
	const [text] = f.find((node) => node.type === "Text")
	assert.equal(text.props.text(), "Ünïcödé…")
	assert.equal(label.props.tooltipText(), "Ünïcödé long label")
	assert.equal(text.props.widthChars(), 8)
	f.set_metrics({ icon_px: 56, cell_px: 100, label_chars: 19 })
	assert.equal(text.props.text(), "Ünïcödé long label")
	assert.equal(label.props.tooltipText(), "")
	f.set_metrics({ icon_px: 56, cell_px: 100, label_chars: 2 })
	assert.equal(text.props.widthChars(), 4)
	assert.equal(text.props.text(), "Ünï…")
	f.set_rename_path("/d/notes.txt")
	assert.equal(text.props.text(), "renamed")
})

test("image and themed icons, cut state and launcher emblem", async () => {
	const image = await fixture({ path: "/d/photo.JPG", name: "photo.JPG" })
	const [picture] = image.find((node) => node.type === "Picture")
	const [themed, emblem] = image.find((node) => node.type === "image")
	assert.equal(picture.props.paintable(), "/d/photo.JPG@64")
	assert.equal(picture.props.visible(), true)
	assert.equal(themed.props.visible(), false)
	image.set_cut_paths(new Set(["/d/photo.JPG"]))
	assert.equal(picture.props.paintable(), "hidden")
	assert.equal(themed.props.iconName(), "edit-cut")
	assert.equal(emblem.props.visible(), false)
	const launcher = await fixture({
		path: "/d/tool.Desktop",
		icon_file: "/icons/tool.png",
	})
	const [launcher_picture] = launcher.find((node) => node.type === "Picture")
	const [launcher_icon, launcher_emblem] = launcher.find(
		(node) => node.type === "image",
	)
	assert.equal(launcher_picture.props.paintable(), "/icons/tool.png@64")
	assert.equal(launcher_emblem.props.visible(), true)
	assert.equal(launcher_emblem.props.iconName, icons.default.ui.link)
	assert.equal(launcher_emblem.props.pixelSize(), 12)
	launcher.set_cut_paths(new Set(["/d/tool.Desktop"]))
	assert.equal(launcher_emblem.props.visible(), false)
	const plain = await fixture()
	const [plain_icon] = plain.find((node) => node.type === "image")
	assert.equal(plain_icon.props.iconName(), "text-x-generic")
	assert.equal(
		plain.find((node) => node.type === "Picture")[0].props.paintable(),
		"hidden",
	)
	assert.equal(launcher_icon.props.iconName(), "edit-cut")
})
