import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { create_state, jsx_runtime, nodes, tick } from "../helpers.ts"

async function settings_fixture({
	visible,
	workspace,
	clients,
}: {
	visible: boolean
	workspace: number
	clients: Record<string, unknown>[]
}) {
	const calls: string[] = []
	const dialog = { visible, show: () => calls.push("show") }
	const { Settings } = await load_module("widget/Settings/index.tsx", {
		ags: {
			createComputed: () => () => false,
			createRoot: () => () => {},
			createState: () => [() => "", () => {}],
			onCleanup: () => {},
		},
		"$lib/app": {
			default: {
				get_application_id: () => "io.Astal.ags2-shell",
				get_window: (name: string) =>
					name === "settings-dialog"
						? dialog
						: { hide: () => calls.push(`hide:${name}`) },
			},
		},
		"ags/gtk4": {
			Gtk: {
				StackTransitionType: { SLIDE_LEFT_RIGHT: 1 },
				Align: { CENTER: 3 },
				Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
				Window: "window",
			},
		},
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"./components/pages": { create_pages: () => [] },
		"$lib/ui": { bind_stack_page: () => () => {} },
		"$lib/hyprland": {
			hyprland: { clients, focusedWorkspace: { id: workspace } },
		},
		"$lib/windowing": {
			focus_client: async (client) => calls.push(`focus:${client.address}`),
			move_client_to_workspace_silent: async (id, client) =>
				calls.push(`move:${client.address}:${id}`),
			raise_client: async (client) => calls.push(`raise:${client.address}`),
		},
		"$shell/options": {
			default: {},
			collect_options: () => [],
			scaled: (px: number) => px,
		},
	})
	return { button: Settings.Button(), calls }
}

function own(workspace: number) {
	return {
		address: "0xshell",
		class: "io.Astal.ags2-shell",
		title: "Settings",
		workspace: { id: workspace },
	}
}
const other_app = {
	address: "0xother",
	class: "org.gnome.Settings",
	title: "Settings",
	workspace: { id: 1 },
}

test("opening Settings shows it when it is closed", async () => {
	const f = await settings_fixture({
		visible: false,
		workspace: 1,
		clients: [],
	})
	f.button.props.onClicked()
	await tick()
	assert.deepEqual(f.calls, ["hide:quicksettings", "show"])
})

test("an open Settings window is focused and raised, and brought over from another workspace", async () => {
	const here = await settings_fixture({
		visible: true,
		workspace: 2,
		clients: [other_app, own(2)],
	})
	here.button.props.onClicked()
	await tick()
	assert.deepEqual(here.calls, [
		"hide:quicksettings",
		"focus:0xshell",
		"raise:0xshell",
	])

	const elsewhere = await settings_fixture({
		visible: true,
		workspace: 3,
		clients: [other_app, own(2)],
	})
	elsewhere.button.props.onClicked()
	await tick()
	assert.deepEqual(elsewhere.calls, [
		"hide:quicksettings",
		"move:0xshell:3",
		"focus:0xshell",
		"raise:0xshell",
	])
})

test("the pager selects the stack page bound to the settings stack", async () => {
	const cleanups: (() => void)[] = []
	const bound: { stack: unknown; page: () => string }[] = []
	const pages = ["Appearance", "Shell", "System"].map((name) => ({
		name,
		icon_name: `${name}-icon`,
		widget: { page: name },
	}))
	let window
	function make(type, props) {
		const node = jsx_runtime.jsx(type, props)
		if (type === "window")
			window = Object.assign(node, { measure: () => [0, 0] })
		if (type === "stack") props.$(node)
		return node
	}
	const { Settings } = await load_module("widget/Settings/index.tsx", {
		ags: {
			createComputed: () => () => false,
			createRoot: (fn) => fn(() => {}),
			createState: (initial) => create_state(initial),
			onCleanup: (cleanup) => cleanups.push(cleanup),
		},
		"$lib/app": {
			default: { get_window: () => null },
		},
		"ags/gtk4": {
			Gtk: {
				StackTransitionType: { SLIDE_LEFT_RIGHT: 1 },
				Align: { CENTER: 3 },
				Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
				Window: "window",
				StackPage: "page",
			},
		},
		"ags/gtk4/jsx-runtime": { ...jsx_runtime, jsx: make, jsxs: make },
		"./components/pages": { create_pages: () => pages },
		"$lib/hyprland": { hyprland: { clients: [] } },
		"$lib/windowing": {
			focus_client: () => {},
			move_client_to_workspace_silent: () => {},
			raise_client: () => {},
		},
		"$lib/ui": {
			bind_stack_page: (stack, page) => {
				bound.push({ stack, page })
				return () => bound.splice(0)
			},
		},
		"$shell/options": {
			default: {},
			collect_options: () => [],
			scaled: (px: number) => px,
		},
	})
	Settings.preload()
	const stack_node = nodes(window, "stack")[0]
	assert.deepEqual(
		nodes(stack_node, "page").map(({ props }) => [
			props.name,
			props.iconName,
			props.child,
		]),
		pages.map(({ name, icon_name, widget }) => [name, icon_name, widget]),
	)
	assert.equal(bound.length, 1)
	assert.equal(bound[0].stack, stack_node)
	assert.equal(bound[0].page(), "Appearance")
	const pager = nodes(window, "button").filter(
		(button) => nodes(button, "label").length,
	)
	pager[2].props.onClicked()
	assert.equal(bound[0].page(), "System")
	assert.equal(pager[2].props.class(), "active")
	assert.equal(pager[0].props.class(), "")
	for (const cleanup of cleanups) cleanup()
	assert.equal(bound.length, 0)
})
