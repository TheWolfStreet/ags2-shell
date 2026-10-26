import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as result_module from "../../lib/result.ts"
import icons from "../../lib/icons.ts"
import {
	accessor,
	create_state,
	nodes,
	read,
	push_idle,
	tick,
	type node,
} from "../helpers.ts"

type app_spec = {
	id: string | null
	name?: string | null
	description?: string | null
	executable?: string | null
	show?: boolean
	launch?: boolean | "throw"
	last_used?: boolean | "throw"
	default?: boolean | "throw"
}

async function open_with_fixture() {
	const events: unknown[][] = []
	const idles: (() => void)[] = []
	const execs: { argv: string[]; fail: boolean }[] = []
	let exec_fails = false
	let window: (node & { present(): void; hide(): void }) | null = null
	const queried = new Map<string, string | null | "throw">()
	const guesses = new Map<string, string | null>()
	const recommended: app_spec[] = []
	const all: app_spec[] = []
	const defaults = new Map<string, string>()

	function app_info(spec: app_spec) {
		const outcome = (value: boolean | "throw" | undefined, label: string) => {
			if (value === "throw") throw new Error(`${label} threw`)
			return value ?? true
		}
		return {
			get_id: () => spec.id,
			get_name: () => (spec.name === undefined ? spec.id : spec.name),
			get_description: () => spec.description ?? null,
			get_executable: () => spec.executable ?? null,
			get_icon: () => null,
			should_show: () => spec.show ?? true,
			launch: (files) => {
				events.push(["launch", spec.id, files.map((file) => file.path)])
				return outcome(spec.launch, "launch")
			},
			set_as_last_used_for_type: (type) => {
				events.push(["last_used", spec.id, type])
				return outcome(spec.last_used, "last_used")
			},
			set_as_default_for_type: (type) => {
				events.push(["default", spec.id, type])
				return outcome(spec.default, "default")
			},
		}
	}

	function make(type, props: Record<string, any> = {}) {
		if (typeof type === "function") return type(props)
		if (type === "Window") {
			window = {
				type,
				props,
				present: () => events.push(["present"]),
				hide: () => events.push(["hide"]),
			}
			return window
		}
		return { type, props }
	}

	const imports = {
		"$lib/app": {
			default: {
				get_window: (name) => {
					assert.equal(name, "desktop-open-with")
					return window
				},
			},
		},
		ags: {
			createState: create_state,
			createComputed: accessor,
			createRoot: (fn) => fn(() => {}),
			For: (props) => ({ type: "for", props }),
		},
		"ags/gtk4": {
			Gdk: { KEY_Escape: 27 },
			Gtk: {
				Align: { CENTER: 3 },
				Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
				Justification: { CENTER: 2 },
				PolicyType: { NEVER: 2 },
				Window: "Window",
				EventControllerKey: "keys",
				ScrolledWindow: "scrolled",
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"ags/process": {
			execAsync: async (argv) => {
				execs.push({ argv, fail: exec_fails })
				if (exec_fails) throw new Error("gio failed")
				return ""
			},
		},
		"$lib/time": { idle: push_idle(idles) },
		"gi://Gio": {
			default: {
				AppInfo: {
					get_recommended_for_type: () => recommended.map(app_info),
					get_all_for_type: () => all.map(app_info),
					get_default_for_type: (type) => {
						const id = defaults.get(type)
						return id === undefined ? null : { get_id: () => id }
					},
				},
				File: {
					new_for_path: (path) => ({
						path,
						get_path: () => path,
						query_info: () => {
							const value = queried.get(path)
							if (value === "throw") throw new Error("query failed")
							return { get_content_type: () => value ?? null }
						},
					}),
				},
				FileQueryInfoFlags: { NONE: 0 },
				content_type_guess: (path) => [guesses.get(path) ?? null],
				content_type_get_description: (type) => `about ${type}`,
			},
		},
		"gi://GLib": {
			default: {
				markup_escape_text: (text) =>
					text.replace(/&/g, "&amp;").replace(/</g, "&lt;"),
			},
		},
		"gi://Pango": { default: { EllipsizeMode: { END: 3 } } },
		"$lib/result": result_module,
		"widget/shared/Placeholder": {
			Placeholder: (props) => ({ type: "placeholder", props }),
		},
		"$lib/icons": { default: icons },
	}
	const { DesktopOpenWith } = await load_module(
		"widget/Desktop/components/OpenWith.tsx",
		imports,
	)

	const tree = () => {
		assert.ok(window)
		return window
	}
	const button = (label: string) =>
		nodes(tree()).find((item) => item.props.label === label)
	const rows = () =>
		nodes(tree(), "for").flatMap((list) =>
			read(list.props.each).map((entry) => list.props.children(entry)),
		)
	const sections = () =>
		nodes(tree())
			.filter((item) => item.props.class === "section")
			.map((item) => [item.props.label, read(item.props.visible)])
	return {
		DesktopOpenWith,
		events,
		idles,
		execs,
		queried,
		guesses,
		recommended,
		all,
		defaults,
		tree,
		button,
		rows,
		sections,
		set_exec_fails: (value: boolean) => {
			exec_fails = value
		},
	}
}

function row_label(row: node) {
	return nodes(row, "label")[0].props.label
}

function selected_rows(rows: node[]) {
	return rows
		.filter((row) => read(row.props.class).includes("selected"))
		.map(row_label)
}

function log_errors(t) {
	const logged: string[][] = []
	t.mock.method(console, "error", (tag, error) => {
		if (String(tag).startsWith("desktop."))
			logged.push([tag, error instanceof Error ? error.message : error])
	})
	return logged
}

test("open lists recommended apps then visible others sorted, preselecting the listed default", async () => {
	const fixture = await open_with_fixture()
	fixture.queried.set("/d/a&b.txt", "text/plain")
	fixture.recommended.push({ id: "editor.desktop", name: "Editor" })
	fixture.all.push(
		{ id: "editor.desktop", name: "Editor" },
		{ id: "zed.desktop", name: "Zed" },
		{ id: "hidden.desktop", name: "Hidden", show: false },
		{ id: "atom.desktop", name: "Atom" },
	)
	fixture.defaults.set("text/plain", "zed.desktop")
	fixture.DesktopOpenWith.open("/d/a&b.txt")
	assert.deepEqual(fixture.events, [["present"]])
	assert.deepEqual(fixture.rows().map(row_label), ["Editor", "Atom", "Zed"])
	assert.deepEqual(selected_rows(fixture.rows()), ["Zed"])
	assert.deepEqual(fixture.sections(), [
		["Recommended Apps", true],
		["Other Apps", true],
	])
	const prompt = nodes(fixture.tree()).find(
		(item) => item.props.class === "prompt",
	)
	assert.equal(
		read(prompt.props.label),
		"Choose an app to open <b>a&amp;b.txt</b>",
	)
	const detail = nodes(fixture.tree()).find(
		(item) => item.props.class === "detail",
	)
	assert.equal(read(detail.props.label), "about text/plain")
	assert.equal(read(fixture.button("Open").props.sensitive), true)

	const focused: string[] = []
	const entry = nodes(fixture.tree(), "entry")[0]
	entry.props.$({ grab_focus: () => focused.push("entry") })
	for (const run of fixture.idles) run()
	assert.deepEqual(focused, ["entry"])
})

test("an unlisted default falls back to the first recommended app, or to nothing", async () => {
	const fixture = await open_with_fixture()
	fixture.queried.set("/d/a", "text/plain")
	fixture.recommended.push({ id: "first.desktop" }, { id: "second.desktop" })
	fixture.defaults.set("text/plain", "elsewhere.desktop")
	fixture.DesktopOpenWith.open("/d/a")
	assert.deepEqual(selected_rows(fixture.rows()), ["first.desktop"])
	fixture.recommended.length = 0
	fixture.DesktopOpenWith.open("/d/a")
	assert.deepEqual(fixture.rows(), [])
	assert.equal(read(fixture.button("Open").props.sensitive), false)
	assert.deepEqual(fixture.sections(), [
		["Recommended Apps", false],
		["Other Apps", false],
	])
	assert.equal(
		fixture.events.filter((event) => event[0] === "present").length,
		2,
	)
})

test("content types come from the file, then a guess, then octet-stream", async () => {
	const fixture = await open_with_fixture()
	const description = () =>
		read(
			nodes(fixture.tree()).find((item) => item.props.class === "detail").props
				.label,
		)
	fixture.queried.set("/d/a", "text/plain")
	fixture.DesktopOpenWith.open("/d/a")
	assert.equal(description(), "about text/plain")
	fixture.queried.set("/d/b.png", "throw")
	fixture.guesses.set("/d/b.png", "image/png")
	fixture.DesktopOpenWith.open("/d/b.png")
	assert.equal(description(), "about image/png")
	fixture.queried.set("/d/c", null)
	fixture.guesses.set("/d/c", "text/guess")
	fixture.DesktopOpenWith.open("/d/c")
	assert.equal(description(), "about text/guess")
	fixture.DesktopOpenWith.open("/d/unknown")
	assert.equal(description(), "about application/octet-stream")
})

test("search filters names and details and shows the empty placeholder", async () => {
	const fixture = await open_with_fixture()
	fixture.recommended.push({
		id: "a.desktop",
		name: "Alpha",
		description: "Edits text",
	})
	fixture.all.push({ id: "b.desktop", name: "Beta", executable: "beta-bin" })
	fixture.DesktopOpenWith.open("/d/x")
	const entry = nodes(fixture.tree(), "entry")[0]
	const placeholder = nodes(fixture.tree(), "placeholder")[0]
	entry.props.onNotifyText({ text: "  TEXT " })
	assert.deepEqual(fixture.rows().map(row_label), ["Alpha"])
	entry.props.onNotifyText({ text: "bin" })
	assert.deepEqual(fixture.rows().map(row_label), ["Beta"])
	assert.equal(read(placeholder.props.visible), false)
	entry.props.onNotifyText({ text: "nothing" })
	assert.deepEqual(fixture.rows(), [])
	assert.equal(read(placeholder.props.visible), true)
	fixture.DesktopOpenWith.open("/d/x")
	assert.equal(read(entry.props.text), "")
	assert.deepEqual(fixture.rows().map(row_label), ["Alpha", "Beta"])
})

test("entries fall back to placeholder ids, names and details", async () => {
	const fixture = await open_with_fixture()
	fixture.recommended.push(
		{ id: null, name: "Named" },
		{ id: null, name: null },
	)
	fixture.DesktopOpenWith.open("/d/x")
	assert.deepEqual(fixture.rows().map(row_label), ["Named", "Unknown"])
	fixture.rows()[1].props.onClicked()
	assert.deepEqual(selected_rows(fixture.rows()), ["Unknown"])
	fixture.rows()[0].props.onClicked()
	assert.deepEqual(selected_rows(fixture.rows()), ["Named"])
})

test("open launches the selection, records it and hides; escape and cancel hide", async (t) => {
	const fixture = await open_with_fixture()
	const logged = log_errors(t)
	fixture.queried.set("/d/a", "text/plain")
	fixture.recommended.push({ id: "editor.desktop" })
	fixture.DesktopOpenWith.open("/d/a")
	fixture.events.length = 0
	fixture.button("Open").props.onClicked()
	assert.deepEqual(fixture.events, [
		["launch", "editor.desktop", ["/d/a"]],
		["last_used", "editor.desktop", "text/plain"],
		["hide"],
	])
	assert.deepEqual(logged, [])

	fixture.events.length = 0
	const keys = nodes(fixture.tree(), "keys")[0]
	assert.equal(keys.props.onKeyPressed(null, 65), false)
	assert.deepEqual(fixture.events, [])
	assert.equal(keys.props.onKeyPressed(null, 27), true)
	fixture.button("Cancel").props.onClicked()
	assert.deepEqual(fixture.events, [["hide"], ["hide"]])
})

test("open with nothing selected does nothing", async (t) => {
	const fixture = await open_with_fixture()
	const logged = log_errors(t)
	fixture.DesktopOpenWith.open("/d/a")
	fixture.events.length = 0
	fixture.button("Open").props.onClicked()
	assert.deepEqual(fixture.events, [])
	assert.deepEqual(logged, [])
})

test("a failed launch is logged and keeps the dialog open", async (t) => {
	const fixture = await open_with_fixture()
	const logged = log_errors(t)
	fixture.recommended.push(
		{ id: "throws.desktop", launch: "throw" },
		{ id: "refuses.desktop", launch: false },
	)
	fixture.DesktopOpenWith.open("/d/a")
	fixture.events.length = 0
	fixture.button("Open").props.onClicked()
	fixture.rows()[1].props.onClicked()
	fixture.button("Open").props.onClicked()
	assert.deepEqual(fixture.events, [
		["launch", "throws.desktop", ["/d/a"]],
		["launch", "refuses.desktop", ["/d/a"]],
	])
	assert.deepEqual(logged, [
		["desktop.open_with: Failed to launch /d/a", "launch threw"],
		["desktop.open_with: Failed to launch /d/a", "launch returned false"],
	])
})

test("a failed last-used record is logged but still hides", async (t) => {
	const fixture = await open_with_fixture()
	const logged = log_errors(t)
	fixture.recommended.push(
		{ id: "throws.desktop", last_used: "throw" },
		{ id: "refuses.desktop", last_used: false },
	)
	fixture.DesktopOpenWith.open("/d/a")
	fixture.button("Open").props.onClicked()
	fixture.rows()[1].props.onClicked()
	fixture.button("Open").props.onClicked()
	assert.deepEqual(logged, [
		[
			"desktop.open_with: Failed to record last used application",
			"last_used threw",
		],
		[
			"desktop.open_with: Failed to record last used application",
			"operation returned false",
		],
	])
	assert.equal(fixture.events.filter((event) => event[0] === "hide").length, 2)
})

test("always use sets the default, falling back to gio mime for desktop ids", async (t) => {
	const fixture = await open_with_fixture()
	const logged = log_errors(t)
	fixture.queried.set("/d/a", "text/plain")
	fixture.recommended.push(
		{ id: "set.desktop" },
		{ id: "refuses.desktop", default: false },
		{ id: "throws.desktop", default: "throw" },
		{ id: "refuses-app", default: false },
		{ id: "throws-app", default: "throw" },
	)
	const always = () => nodes(fixture.tree(), "switch")[0]
	const choose = (index: number) => {
		fixture.DesktopOpenWith.open("/d/a")
		fixture.rows()[index].props.onClicked()
		always().props.onNotifyActive({ active: true })
		assert.equal(read(always().props.active), true)
		fixture.button("Open").props.onClicked()
	}

	fixture.DesktopOpenWith.open("/d/a")
	fixture.events.length = 0
	fixture.button("Open").props.onClicked()
	assert.equal(
		fixture.events.some((event) => event[0] === "default"),
		false,
	)

	fixture.events.length = 0
	choose(0)
	assert.deepEqual(fixture.events.slice(-3), [
		["last_used", "set.desktop", "text/plain"],
		["default", "set.desktop", "text/plain"],
		["hide"],
	])
	choose(1)
	choose(2)
	fixture.set_exec_fails(true)
	choose(1)
	await tick()
	assert.deepEqual(fixture.execs, [
		{ argv: ["gio", "mime", "text/plain", "refuses.desktop"], fail: false },
		{ argv: ["gio", "mime", "text/plain", "throws.desktop"], fail: false },
		{ argv: ["gio", "mime", "text/plain", "refuses.desktop"], fail: true },
	])
	assert.deepEqual(logged, [
		["desktop.open_with: Failed to set default for text/plain", "gio failed"],
	])
	logged.length = 0
	choose(3)
	choose(4)
	assert.deepEqual(logged, [
		[
			"desktop.open_with: Failed to set default for text/plain",
			"set_as_default_for_type returned false",
		],
		[
			"desktop.open_with: Failed to set default for text/plain",
			"default threw",
		],
	])
	assert.equal(fixture.execs.length, 3)
})

test("the window is built once and reused", async () => {
	const fixture = await open_with_fixture()
	fixture.DesktopOpenWith.open("/d/a")
	const first = fixture.tree()
	fixture.DesktopOpenWith.open("/d/b")
	assert.equal(fixture.tree(), first)
	assert.equal(first.props.name, "desktop-open-with")
	assert.equal(first.props.hideOnClose, true)
})
