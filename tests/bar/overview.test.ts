import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { load_module } from "../load_module.ts"
import { with_hyprland_command } from "../hyprland.ts"
import { accessor, nodes, tick } from "../helpers.ts"

test.afterEach(() => mock.restoreAll())

type fake_timer = { callback: () => void; cancelled: boolean; cancel(): void }

async function overview_fixture(
	client: Record<string, any> | null = null,
	{
		focused_client = null as object | null,
		focused_workspace = null as object | null,
		workspace = null as object | null,
		overview_scale = 100,
	} = {},
) {
	const requests: ((source: unknown, result: object) => void)[] = []
	const timers: fake_timer[] = []
	const mounts: (() => void)[] = []
	const cleanups: (() => void)[] = []
	const messages: string[] = []
	const moves: [number, string][] = []
	const subscriptions = new Set<string>()
	let toggle
	let refreshes = 0
	const subscribable = (name: string, get) =>
		accessor(get, () => {
			subscriptions.add(name)
			return () => subscriptions.delete(name)
		})
	const make = (type, props: Record<string, any> = {}) => {
		if (typeof type === "function") return type(props)
		const node = {
			type,
			props,
			children: (Array.isArray(props.children)
				? props.children
				: [props.children]
			).filter(Boolean),
		}
		props.$?.(node)
		return node
	}
	const hyprland = {
		clients: [] as unknown[],
		workspaces: [],
		monitors: [],
		focusedWorkspace: focused_workspace,
		get_workspace: () => workspace,
		get_focused_monitor: () => null,
		get_client: (address) => (address === "0xdef" ? null : {}),
		message_async: async (message) => {
			messages.push(message)
			return "ok"
		},
		sync_clients: (callback) => {
			requests.push(callback)
		},
		sync_clients_finish: (result) => {
			if (result.error) throw result.error
		},
	}
	const { Overview } = await load_module(
		"widget/Bar/components/Overview/index.tsx",
		{
			ags: {
				createBinding: (object, property) => accessor(() => object[property]),
				createComputed: (fn) => subscribable("monitor", fn),
				For: ({ each, children }) => each().map(children),
				onCleanup: (fn) => cleanups.push(fn),
				onMount: (fn) => mounts.push(fn),
			},
			"$lib/time": {
				idle: () => ({ cancel() {} }),
				timeout: (_ms, callback) => {
					const timer: fake_timer = {
						callback,
						cancelled: false,
						cancel() {
							this.cancelled = true
						},
					}
					timers.push(timer)
					return timer
				},
			},
			"$lib/app": { default: { get_window: () => null } },
			"ags/gtk4": {
				Astal: { Layer: { OVERLAY: 1 } },
				Gdk: {
					DragAction: { MOVE: 1 },
					BUTTON_MIDDLE: 2,
					ContentProvider: { new_for_value: (value) => value },
					ContentFormats: { new_for_gtype: (value) => value },
				},
				Gtk: {
					Align: { CENTER: 1, FILL: 2 },
					GestureClick: "gesture-click",
					DragSource: "drag-source",
					DropTarget: "drop-target",
					Fixed: "fixed",
					WidgetPaintable: { new: (widget) => ({ paints: widget }) },
				},
			},
			"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
			"ags/gobject": { default: { TYPE_STRING: 1 } },
			"widget/shared/PopupWindow": {
				PopupWindow: (props) => make("popup-window", props),
			},
			"../PanelButton": { PanelButton: () => null },
			"$lib/hyprland": with_hyprland_command({ hyprland }),
			"$lib/windowing": {
				close_client: (target) => target.kill(),
				create_client_title_accessor: () => null,
				create_workspace_clients: () =>
					accessor(() => (client ? [client] : [])),
				focus_client: (target) => target.focus(),
				focused_window_client: accessor(() => focused_client),
				move_client_to_workspace_silent: (workspace_id, address) =>
					moves.push([workspace_id, address]),
				on_window_toggle: (_name, callback) => {
					toggle = callback
					return () => {}
				},
				client_placement_version: accessor(
					() => 0,
					() => {
						subscriptions.add("placement")
						return () => subscriptions.delete("placement")
					},
				),
				refresh_client_placement: () => {
					refreshes++
				},
			},
			"$shell/options": {
				scaled: (px) => accessor(() => px),
				default: {
					overview: {
						workspaces: () => 1,
						scale: subscribable("scale", () => overview_scale),
					},
					scale: accessor(() => 100),
				},
			},
		},
	)
	const root = Overview.Window()
	for (const mount of mounts.splice(0)) mount()
	return {
		root,
		requests,
		timers,
		hyprland,
		messages,
		moves,
		subscriptions,
		toggle: (visible) => toggle({ visible }),
		finish: (index) => requests[index](null, {}),
		fail: (index, error) => requests[index](null, { error }),
		fire: (index) => {
			timers[index].cancelled = true
			timers[index].callback()
		},
		refreshes: () => refreshes,
		cleanup: () => {
			for (const cleanup of cleanups) cleanup()
		},
	}
}

function example_client(counts = { focused: 0, killed: 0, connected: 0 }) {
	return {
		address: "0x1",
		get_address: () => "0x1",
		get_width: () => 800,
		get_height: () => 600,
		get_class: () => "example",
		get_workspace: () => ({ id: 1 }),
		focus: () => {
			counts.focused++
		},
		kill: () => {
			counts.killed++
		},
		connect: () => ++counts.connected,
		disconnect: () => {
			counts.connected--
		},
	}
}

function client_button(root) {
	return nodes(root).find(
		(node) =>
			node.type === "button" &&
			node.children.some((child) => child.type === "drag-source"),
	)
}

test("overview client middle click kills and resets without focusing; primary click and drag remain", async () => {
	const counts = { focused: 0, killed: 0, connected: 0 }
	let resets = 0
	const fixture = await overview_fixture(example_client(counts))
	const button = client_button(fixture.root)
	assert.ok(button)
	const gesture = button.children.find(
		(child) => child.type === "gesture-click",
	)
	assert.ok(gesture)
	assert.equal(gesture.props.button, 2)
	assert.equal(
		button.children.find((child) => child.type === "drag-source").props.content,
		"0x1",
	)
	gesture.props.onPressed({
		reset: () => {
			resets++
		},
	})
	assert.equal(counts.killed, 1)
	assert.equal(resets, 1)
	assert.equal(counts.focused, 0)
	button.props.onClicked()
	assert.equal(counts.focused, 1)
	assert.equal(counts.killed, 1)
	fixture.cleanup()
})

test("overview clients and workspaces scale, highlight focus and track their sources", async () => {
	const counts = { focused: 0, killed: 0, connected: 0 }
	const client = example_client(counts)
	const fixture = await overview_fixture(client, {
		focused_client: { address: "0x1" },
		focused_workspace: { id: 1 },
	})
	const button = client_button(fixture.root)
	assert.equal(button.props.class(), "client active")
	assert.equal(button.props.widthRequest(), 72)
	assert.equal(button.props.heightRequest(), 54)
	const workspace = nodes(fixture.root).find(
		(node) => node.type === "button" && node.props.name === "1",
	)
	assert.equal(workspace.props.class(), "workspace active")
	assert.equal(
		workspace.props.css(),
		"min-width: 172.79999999999998px; min-height: 97.2px;",
	)
	assert.equal(counts.connected, 6)
	assert.deepEqual([...fixture.subscriptions].sort(), [
		"monitor",
		"placement",
		"scale",
	])
	fixture.cleanup()
	assert.equal(counts.connected, 0)
	assert.deepEqual([...fixture.subscriptions], [])

	const plain = await overview_fixture(example_client(), {
		focused_client: { address: "0x2" },
		focused_workspace: { id: 2 },
		overview_scale: 10,
		workspace: {
			monitor: {
				transform: 1,
				scale: 2,
				width: 2000,
				height: 1000,
				get_x: () => 0,
				get_y: () => 0,
			},
		},
	})
	const plain_button = client_button(plain.root)
	assert.equal(plain_button.props.class(), "client")
	assert.equal(plain_button.props.widthRequest(), 80)
	assert.equal(plain_button.props.heightRequest(), 60)
	const plain_workspace = nodes(plain.root).find(
		(node) => node.type === "button" && node.props.name === "1",
	)
	assert.equal(plain_workspace.props.class(), "workspace")
	assert.equal(
		plain_workspace.props.css(),
		"min-width: 50px; min-height: 100px;",
	)
	plain.cleanup()
})

test("overview drag icon, workspace drop and workspace click", async () => {
	const fixture = await overview_fixture(example_client())
	const button = client_button(fixture.root)
	const drag = button.children.find((child) => child.type === "drag-source")
	const icons_set: unknown[][] = []
	drag.props.onDragBegin({ set_icon: (...args) => icons_set.push(args) })
	const image = button.children.find((child) => child.type === "image")
	assert.deepEqual(icons_set, [[{ paints: image }, 8, 8]])
	const workspace = nodes(fixture.root).find(
		(node) => node.type === "button" && node.props.name === "1",
	)
	const drop = workspace.children.find((child) => child.type === "drop-target")
	assert.equal(
		drop.props.onAccept(null, {
			get_formats: () => ({ contain_gtype: (type) => type === 1 }),
		}),
		true,
	)
	for (const value of [42, "0xzz", "", "0xdef"])
		assert.equal(drop.props.onDrop(null, value), false, String(value))
	assert.deepEqual(fixture.moves, [])
	assert.equal(drop.props.onDrop(null, "0xabc"), true)
	assert.deepEqual(fixture.moves, [[1, "0xabc"]])
	workspace.props.onClicked()
	await tick()
	assert.deepEqual(fixture.messages, [
		"dispatch hl.dsp.focus({ workspace = 1 })",
	])
	fixture.cleanup()
})

test("overview refreshes placement only when the client snapshot changes", async () => {
	const fixture = await overview_fixture()
	fixture.toggle(true)
	fixture.finish(0)
	assert.equal(fixture.refreshes(), 0)
	fixture.hyprland.clients = [
		{ address: "b", workspace: { id: 2 }, x: 1, y: 2, width: 3, height: 4 },
		{ address: "a", workspace: { id: 1 }, x: 5, y: 6, width: 7, height: 8 },
	]
	fixture.fire(0)
	fixture.finish(1)
	assert.equal(fixture.refreshes(), 1)
	fixture.hyprland.clients = [...fixture.hyprland.clients].reverse()
	fixture.fire(1)
	fixture.finish(2)
	assert.equal(fixture.refreshes(), 1)
	fixture.hyprland.clients = [
		{ address: "b", workspace: { id: 2 }, x: 1, y: 2, width: 3, height: 5 },
		{ address: "a", workspace: { id: 1 }, x: 5, y: 6, width: 7, height: 8 },
	]
	fixture.fire(2)
	fixture.finish(3)
	assert.equal(fixture.refreshes(), 2)
	fixture.toggle(false)
	fixture.cleanup()
})

test("overview warns once per failure streak and only a fresh success resets it", async () => {
	const warnings: unknown[][] = []
	mock.method(console, "warn", (...args) => {
		if (String(args[0]).startsWith("overview")) warnings.push(args)
	})
	const fixture = await overview_fixture()
	const failure = new Error("socket")
	fixture.toggle(true)
	fixture.fail(0, failure)
	assert.deepEqual(warnings, [
		["overview: Hyprland client sync failed", failure],
	])
	fixture.fire(0)
	fixture.toggle(false)
	fixture.toggle(true)
	fixture.finish(1)
	fixture.fire(1)
	fixture.fail(2, failure)
	assert.equal(warnings.length, 1)
	fixture.fire(2)
	fixture.finish(3)
	fixture.fire(3)
	fixture.fail(4, failure)
	assert.equal(warnings.length, 2)
	assert.equal(fixture.requests.length, 5)
	fixture.toggle(false)
	fixture.cleanup()
})

for (const order of ["completion first", "timer first"])
	test(`reopen retains one sync and refreshes after stale ${order}`, async () => {
		const fixture = await overview_fixture()
		fixture.toggle(true)
		assert.equal(fixture.requests.length, 1)
		fixture.toggle(false)
		fixture.toggle(true)
		assert.equal(fixture.timers.length, 1)
		if (order === "timer first") fixture.fire(0)
		fixture.hyprland.clients = [
			{
				address: "new",
				workspace: { id: 1 },
				x: 1,
				y: 1,
				width: 10,
				height: 10,
			},
		]
		fixture.finish(0)
		assert.equal(fixture.refreshes(), 0)
		assert.equal(fixture.requests.length, 1)
		if (order === "completion first") fixture.fire(0)
		else fixture.fire(1)
		assert.equal(fixture.requests.length, 2)
		fixture.finish(1)
		assert.equal(fixture.refreshes(), 1)
		assert.equal(fixture.timers.filter((timer) => !timer.cancelled).length, 1)
		fixture.toggle(false)
		fixture.cleanup()
	})

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
	assert.equal(fixture.timers.filter((timer) => !timer.cancelled).length, 0)
	fixture.toggle(true)
	assert.equal(fixture.requests.length, 2)
	fixture.cleanup()
})
