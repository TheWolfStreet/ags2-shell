import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { load_module } from "../load_module.ts"
import * as result from "../../lib/result.ts"
import { create_state, nodes } from "../helpers.ts"

test.afterEach(() => mock.restoreAll())

async function bar_fixture({
	position = "top-center",
	transparent = false,
	realized = false,
} = {}) {
	const [position_option, set_position, position_listeners] =
		create_state(position)
	const [transparent_option, set_transparent] = create_state(transparent)
	const [corners, set_corners] = create_state(50)
	const [roundness] = create_state(12)
	const [gaps] = create_state(2.4)
	const [padding] = create_state(8)
	const [location] = create_state("dock")
	const [recording] = create_state(false)
	const idles: { callback: () => void; cancelled: boolean }[] = []
	const cleanups: (() => void)[] = []
	const zones: number[] = []
	const regions: object[] = []
	const released: unknown[] = []
	const handlers = new Map<number, { target: string; event: string; fn }>()
	let serial = 0
	let root
	let stop_result = result.ok(undefined)
	const connectable = (target: string) => ({
		connect(event, fn) {
			handlers.set(++serial, { target, event, fn })
			return serial
		},
		disconnect(id) {
			handlers.delete(id)
		},
	})
	const surface = {
		...connectable("surface"),
		get_width: () => 1920,
		get_height: () => 300,
		set_input_region: (region) => regions.push(region.rectangles),
	}
	let surface_ready = true
	const make = (type, props: Record<string, any> = {}) => {
		if (typeof type === "function") return type(props)
		const node: Record<string, any> = {
			type,
			props,
			children: (Array.isArray(props.children)
				? props.children
				: [props.children]
			).filter(Boolean),
		}
		if (type === "window") {
			Object.assign(node, connectable("window"), {
				get_surface: () => (surface_ready ? surface : null),
				get_realized: () => realized,
			})
			root = node
		}
		if (props.class === "panel") node.measure = () => [30, 40]
		props.$?.(node)
		return node
	}
	const button = (name: string) => () => make(name)
	const { Bar } = await load_module("widget/Bar/index.tsx", {
		ags: {
			createBinding: (object, property) => object[property],
			createComputed: (fn) =>
				Object.assign(fn, { as: (map) => () => map(fn()) }),
			onCleanup: (fn) => cleanups.push(fn),
		},
		"ags/gtk4": {
			Astal: {
				WindowAnchor: { TOP: 1, BOTTOM: 2, LEFT: 4, RIGHT: 8 },
				Layer: { TOP: 3 },
			},
			Gdk: {},
			Gtk: {
				Align: { CENTER: 1, START: 2, END: 3 },
				Orientation: { VERTICAL: 1 },
				Overflow: { HIDDEN: 1 },
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"$lib/time": {
			idle: (callback) => {
				const timer = {
					callback,
					cancelled: false,
					cancel() {
						this.cancelled = true
					},
				}
				idles.push(timer)
				return timer
			},
			format_clock: (value) => `clock ${value}`,
		},
		cairo: {
			default: {
				Region: class {
					rectangles: object[] = []
					unionRectangle(rectangle) {
						this.rectangles.push(rectangle)
					}
				},
			},
		},
		"gi://Gtk4LayerShell": {
			default: {
				set_exclusive_zone: (window, zone) => {
					assert.equal(window, root)
					zones.push(zone)
				},
			},
		},
		"./components/DateMenu": { DateMenu: { Button: button("datemenu") } },
		"./components/Buttons/Battery": { Battery: button("battery") },
		"./components/Buttons/ColorPicker": { ColorPicker: button("colorpicker") },
		"./components/Buttons/MediaIndicator": {
			MediaIndicator: button("media"),
		},
		"./components/Buttons/SystemTray": { SystemTray: button("tray") },
		"./components/Buttons/WindowList": { WindowList: button("windows") },
		"./components/PanelButton": {
			PanelButton: (props) => make("panel-button", props),
		},
		"./components/Launcher": { Launcher: { Button: button("launcher") } },
		"./components/Overview": { Overview: { Button: button("overview") } },
		"./components/Notifications": {
			Notifications: { Button: button("notifications") },
		},
		"./components/QuickSettings": {
			QuickSettings: { Button: button("quicksettings") },
		},
		"widget/PowerMenu": { PowerMenu: { Button: button("powermenu") } },
		"$shell/options": {
			default: {
				bar: {
					transparent: transparent_option,
					position: position_option,
					corners,
				},
				theme: { padding, roundness },
				hyprland: { gaps },
				taskbar: { location },
			},
		},
		"$lib/windowing": {
			schedule_monitor_window_release: (window) => released.push(window),
			track_monitor_fullscreen: () => create_state(false)[0],
		},
		"$service/screen_capture": {
			screen_capture: {
				recording,
				timer: create_state(5)[0],
				stop_recording: () => stop_result,
			},
		},
	})
	Bar({ gdkmonitor: {} })
	return {
		root,
		zones,
		regions,
		released,
		idles,
		handlers,
		set_position,
		set_transparent,
		set_corners,
		position_listeners,
		set_stop_result: (value) => {
			stop_result = value
		},
		realize: () => {
			realized = true
			for (const handler of [...handlers.values()])
				if (handler.target === "window" && handler.event === "realize")
					handler.fn()
		},
		layout: () => {
			for (const handler of [...handlers.values()])
				if (handler.target === "surface" && handler.event === "layout")
					handler.fn()
		},
		set_surface_ready: (value) => {
			surface_ready = value
		},
		run_idle: () => {
			for (const timer of idles.splice(0))
				if (!timer.cancelled) timer.callback()
		},
		cleanup: () => {
			for (const cleanup of cleanups) cleanup()
		},
	}
}

function corner(root, edge: string) {
	return nodes(root).find(
		(node) =>
			typeof node.props.class === "function" &&
			node.props.class().endsWith(edge),
	)
}

test("the bar anchors, aligns and shows the corner on its configured edge", async () => {
	const f = await bar_fixture()
	assert.equal(f.root.props.anchor(), 1 | 4 | 8)
	assert.equal(f.root.props.layer, 3)
	assert.equal(f.root.props.name, "bar")
	assert.equal(f.root.props.visible(), true)
	assert.equal(f.root.props.class(), "bar")
	const content = f.root.children[0]
	assert.equal(content.props.valign(), 2)
	assert.equal(corner(f.root, "top-center").props.visible(), true)
	assert.equal(corner(f.root, "bottom-center").props.visible(), false)
	assert.equal(
		corner(f.root, "top-center").props.class(),
		"screen-corner corners top-center",
	)
	f.set_position("bottom-center")
	assert.equal(f.root.props.anchor(), 2 | 4 | 8)
	assert.equal(content.props.valign(), 3)
	assert.equal(corner(f.root, "top-center").props.visible(), false)
	assert.equal(corner(f.root, "bottom-center").props.visible(), true)
	f.set_transparent(true)
	assert.equal(f.root.props.class(), "bar transparent")
	assert.equal(corner(f.root, "bottom-center").props.visible(), false)
	f.set_corners(27)
	assert.equal(
		corner(f.root, "bottom-center").props.class(),
		"screen-corner flat bottom-center",
	)
	f.set_corners(28)
	assert.equal(
		corner(f.root, "bottom-center").props.class(),
		"screen-corner corners bottom-center",
	)
	f.cleanup()
})

test("the panel reserves its height and takes input only over the panel", async () => {
	const f = await bar_fixture()
	f.layout()
	assert.deepEqual(f.zones, [])
	f.realize()
	assert.deepEqual(f.zones, [40])
	assert.deepEqual(f.regions, [[{ x: 0, y: 0, width: 1920, height: 40 }]])
	f.layout()
	assert.deepEqual(f.zones, [40, 40])
	f.set_position("bottom-center")
	f.set_position("bottom-center")
	assert.equal(f.idles.filter((timer) => !timer.cancelled).length, 1)
	f.run_idle()
	assert.deepEqual(f.zones, [40, 40, 0, 40])
	assert.deepEqual(f.regions.at(-1), [
		{ x: 0, y: 260, width: 1920, height: 40 },
	])
	f.realize()
	assert.deepEqual(f.zones, [40, 40, 0, 40])
	f.set_surface_ready(false)
	f.layout()
	f.set_position("top-center")
	f.run_idle()
	assert.deepEqual(f.zones, [40, 40, 0, 40, 0])
	f.cleanup()
	assert.equal(f.handlers.size, 0)
	assert.deepEqual(f.released, [f.root])
	assert.equal(f.position_listeners.size, 0)
})

test("an already realized window hooks its surface at once and cleanup cancels a pending reposition", async () => {
	const f = await bar_fixture({ position: "bottom-center", realized: true })
	assert.deepEqual(f.regions, [[{ x: 0, y: 260, width: 1920, height: 40 }]])
	f.set_position("top-center")
	f.cleanup()
	assert.equal(f.idles.filter((timer) => !timer.cancelled).length, 0)
	assert.deepEqual(f.zones, [40])
})

test("the recording indicator stops the recorder and logs a failure", async () => {
	const errors: unknown[][] = []
	mock.method(console, "error", (...args) => {
		if (String(args[0]).startsWith("bar")) errors.push(args)
	})
	const f = await bar_fixture()
	const recorder = nodes(f.root).find(
		(node) => node.props.class === "recorder",
	)!
	assert.equal(recorder.type, "panel-button")
	assert.equal(recorder.props.visible(), false)
	const [label] = nodes(recorder, "label")
	assert.equal(label.props.label(), "clock 5 ")
	recorder.props.onClicked()
	assert.deepEqual(errors, [])
	const failure = new Error("busy")
	f.set_stop_result(result.err(failure))
	recorder.props.onClicked()
	assert.deepEqual(errors, [
		["bar.recording: Failed to stop recording", failure],
	])
	f.cleanup()
})
