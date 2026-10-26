import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as lua from "../../lib/lua.ts"
import * as icons from "../../lib/icons.ts"
import {
	accessor,
	with_hyprland_command,
	for_node,
	create_state,
	jsx_runtime,
	make,
	nodes,
	tick,
} from "../helpers.ts"

const monitor_configuration = await load_module(
	"service/monitor_configuration.ts",
	{ "$lib/lua": lua },
)

function monitor(name: string, fields: Record<string, unknown> = {}) {
	return {
		name,
		model: name === "eDP-1" ? "Panel" : "External",
		disabled: false,
		mirrorOf: "none",
		width: 1920,
		height: 1080,
		refreshRate: 60,
		x: 0,
		y: 0,
		scale: 1,
		transform: 0,
		...fields,
	}
}

async function mirroring({
	monitors = [monitor("eDP-1"), monitor("DP-1", { x: 1920 })],
	focused = "eDP-1",
	opened = "mirror-selector",
	scale = 100,
} = {}) {
	const state = {
		monitors: monitors as unknown,
		read: async () => JSON.stringify(state.monitors),
		reply: "ok",
		focused,
	}
	const reads: string[] = []
	const messages: string[] = []
	const errors: unknown[][] = []
	const handlers = new Map<string, () => void>()
	const signals = new Map<number, string>()
	let serial = 0
	const subscribers: (() => void)[] = []
	const cleanups: (() => void)[] = []
	let opened_name = opened
	const opened_menu = Object.assign(
		accessor(() => opened_name),
		{
			subscribe: (callback: () => void) => {
				subscribers.push(callback)
				return () => subscribers.splice(subscribers.indexOf(callback), 1)
			},
		},
	)
	const scale_option = accessor(() => scale)
	const imports = {
		"ags/gtk4": {
			Gtk: {
				Orientation: { VERTICAL: 1 },
				Align: { CENTER: 1 },
				PolicyType: { NEVER: 1 },
				ScrolledWindow: "scroll",
			},
		},
		"ags/gtk4/jsx-runtime": jsx_runtime,
		ags: {
			createState: create_state,
			onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
			For: for_node,
		},
		"widget/shared/Placeholder": {
			Placeholder: (props) => make("placeholder", props),
		},
		"./MenuControls": {
			ToggleButton: (props) => make("toggle", props),
			Menu: (props) => make("menu", props),
			quick_settings_submenu: {
				opened: opened_menu,
				toggle(name: string) {
					opened_name = opened_name === name ? "" : name
				},
			},
		},
		"$lib/hyprland": with_hyprland_command({
			hyprland: {
				get focusedMonitor() {
					return { name: state.focused }
				},
				connect: (signal: string, callback: () => void) => {
					handlers.set(signal, callback)
					signals.set(++serial, signal)
					return serial
				},
				disconnect: (id: number) => handlers.delete(signals.get(id)!),
				message_async: async (command: string) => {
					if (command === "j/monitors all") {
						reads.push(command)
						return state.read()
					}
					messages.push(command)
					return state.reply
				},
			},
		}),
		"$service/monitor_configuration": monitor_configuration,
		"$shell/options": {
			default: { transition: { duration: 0 }, scale: scale_option },
			scaled: (px: number) =>
				scale_option.as((s) => Math.round((px * s) / 100)),
		},
	}
	const { DisplayMirroring } = await load_module(
		"widget/Bar/components/QuickSettings/components/DisplayMirroring.tsx",
		imports,
	)
	await tick()
	const original_error = console.error
	console.error = (...args) => errors.push(args)
	let root = DisplayMirroring.Selector()
	await tick()
	const buttons = () => nodes(root).filter((node) => node.type === "button")
	const entry = (name: string) =>
		buttons().find((button) =>
			nodes(button).some(
				(node) =>
					node.type === "label" && String(node.props.label).includes(name),
			),
		)
	return {
		DisplayMirroring,
		state,
		reads,
		messages,
		errors,
		handlers,
		subscribers,
		cleanups,
		root: () => root,
		remount: async () => {
			root = DisplayMirroring.Selector()
			await tick()
		},
		open: (name: string) => {
			opened_name = name
			for (const subscriber of [...subscribers]) subscriber()
		},
		buttons,
		labels: () =>
			buttons().map(
				(button) =>
					nodes(button).find((node) => node.type === "label").props.label,
			),
		click: async (name: string) => {
			const button = entry(name)
			assert.ok(button, name)
			button.props.onClicked()
			await tick()
			await tick()
		},
		restore: () => {
			console.error = original_error
		},
	}
}

test("externally mirrored target can be unmirrored without a saved snapshot", async () => {
	const target = monitor("DP-1", {
		mirrorOf: "eDP-1",
		width: 2560,
		height: 1440,
		x: 2560,
		y: 120,
		scale: 1.5,
		transform: 1,
	})
	const t = await mirroring({ monitors: [monitor("eDP-1"), target] })
	try {
		const [button] = t.buttons()
		assert.ok(button)
		assert.notEqual(button.props.sensitive, false)
		await t.click("DP-1")
		assert.deepEqual(t.reads, [
			"j/monitors all",
			"j/monitors all",
			"j/monitors all",
		])
		assert.deepEqual(t.messages, [
			'eval hl.monitor({ output = "DP-1", mode = "2560x1440@60", position = "2560x120", scale = 1.5, transform = 1, mirror = "none" })',
		])
		assert.deepEqual(t.errors, [])
	} finally {
		t.restore()
	}
})

test("mirroring prefers the focused source and unmirroring restores the saved snapshot", async () => {
	const panel = monitor("eDP-1")
	const external = monitor("DP-1", { x: 1920, scale: 1.25 })
	const third = monitor("HDMI-A-1", { x: 3840 })
	const t = await mirroring({
		monitors: [external, panel, third],
		focused: "eDP-1",
	})
	try {
		assert.deepEqual(t.labels(), ["External (DP-1) ", "External (HDMI-A-1) "])
		await t.click("DP-1")
		assert.deepEqual(t.messages, [
			'eval hl.monitor({ output = "DP-1", mode = "1920x1080@60", position = "1920x0", scale = 1.25, transform = 0, mirror = "eDP-1" })',
		])
		t.state.monitors = [
			{ ...external, mirrorOf: "eDP-1", x: 0, scale: 1 },
			panel,
			third,
		]
		t.handlers.get("monitor-added")!()
		await tick()
		assert.deepEqual(t.labels(), [
			"External (DP-1) (Mirrored)",
			"External (HDMI-A-1) ",
		])
		await t.click("DP-1")
		assert.equal(
			t.messages[1],
			'eval hl.monitor({ output = "DP-1", mode = "1920x1080@60", position = "1920x0", scale = 1.25, transform = 0, mirror = "none" })',
		)
		assert.deepEqual(t.errors, [])
	} finally {
		t.restore()
	}
})

test("the first enabled unmirrored monitor is the source when the focused one is ineligible", async () => {
	const t = await mirroring({
		monitors: [
			monitor("eDP-1", { disabled: true }),
			monitor("DP-1", { mirrorOf: "HDMI-A-1" }),
			monitor("HDMI-A-1"),
			monitor("DP-2"),
		],
		focused: "eDP-1",
	})
	try {
		assert.deepEqual(t.labels(), [
			"External (DP-1) (Mirrored)",
			"External (DP-2) ",
		])
		await t.click("DP-2")
		assert.match(t.messages[0], /output = "DP-2".*mirror = "HDMI-A-1"/)
	} finally {
		t.restore()
	}
})

test("a target without any source monitor logs and sends nothing", async () => {
	const t = await mirroring({
		monitors: [monitor("eDP-1", { mirrorOf: "DP-1" }), monitor("DP-1")],
		focused: "DP-1",
	})
	try {
		await t.click("eDP-1")
		t.state.monitors = [monitor("eDP-1", { disabled: true }), monitor("DP-1")]
		await t.click("eDP-1")
		assert.equal(t.messages.length, 1)
		t.state.monitors = [monitor("eDP-1"), monitor("DP-1", { disabled: true })]
		await t.click("eDP-1")
		assert.deepEqual(t.errors, [
			["display_mirroring: No source monitor available"],
		])
		assert.equal(t.messages.length, 1)
	} finally {
		t.restore()
	}
})

test("a rejected command is logged, not remembered and does not refresh", async () => {
	const t = await mirroring()
	try {
		t.state.reply = "error: bad monitor"
		const reads = t.reads.length
		await t.click("DP-1")
		assert.equal(t.reads.length, reads + 1)
		assert.equal(t.errors.length, 1)
		assert.equal(
			t.errors[0][0],
			"display_mirroring: Failed to change display configuration",
		)
		assert.match(String(t.errors[0][1]), /bad monitor/)
		t.state.reply = "ok"
		t.state.monitors = [
			monitor("eDP-1"),
			monitor("DP-1", { x: 50, mirrorOf: "eDP-1" }),
		]
		await t.click("DP-1")
		assert.match(t.messages.at(-1)!, /position = "50x0".*mirror = "none"/)
	} finally {
		t.restore()
	}
})

test("monitor read failures are logged with the read tag and keep the list", async () => {
	const t = await mirroring()
	try {
		const before = t.labels()
		const failure = new Error("socket closed")
		t.state.read = async () => {
			throw failure
		}
		t.handlers.get("monitor-added")!()
		await tick()
		t.state.read = async () => "not json"
		t.handlers.get("monitor-removed")!()
		await tick()
		t.state.read = async () => JSON.stringify({ name: "DP-1" })
		t.handlers.get("monitor-added")!()
		await tick()
		t.state.read = async () => JSON.stringify([monitor("DP-1", { width: 0 })])
		t.handlers.get("monitor-added")!()
		await tick()
		t.state.read = async () =>
			JSON.stringify([monitor("DP-1", { mirrorOf: 3 })])
		t.handlers.get("monitor-added")!()
		await tick()
		assert.deepEqual(
			t.errors.map(([tag]) => tag),
			Array(5).fill("display_mirroring.read:"),
		)
		assert.equal(t.errors[0][1], failure)
		assert.ok(t.errors[1][1] instanceof SyntaxError)
		assert.equal(
			(t.errors[2][1] as Error).message,
			"Invalid monitor configuration",
		)
		assert.deepEqual(t.labels(), before)
		await t.click("DP-1")
		assert.equal(t.errors.length, 6)
		assert.deepEqual(t.messages, [])
	} finally {
		t.restore()
	}
})

test("disabled monitors may omit geometry and are never listed", async () => {
	const t = await mirroring({
		monitors: [
			monitor("eDP-1"),
			monitor("DP-1", { disabled: true, width: 0, height: 0, scale: 0 }),
		],
	})
	try {
		assert.deepEqual(t.errors, [])
		assert.deepEqual(t.labels(), [])
		const [placeholder, list] = nodes(t.root()).filter(
			(node) => node.type === "revealer",
		)
		assert.equal(placeholder.props.revealChild(), true)
		assert.equal(list.props.revealChild(), false)
	} finally {
		t.restore()
	}
})

test("a click while one is pending is ignored", async () => {
	const t = await mirroring()
	try {
		let release: () => void = () => {}
		const read = t.state.read
		t.state.read = () =>
			new Promise((resolve) => {
				release = () => resolve(read())
			})
		const button = t.buttons()[0]
		button.props.onClicked()
		button.props.onClicked()
		await tick()
		assert.equal(t.reads.length, 2)
		t.state.read = read
		release()
		await tick()
		await tick()
		assert.equal(t.messages.length, 1)
		button.props.onClicked()
		await tick()
		await tick()
		assert.equal(t.messages.length, 2)
	} finally {
		t.restore()
	}
})

test("a snapshot is dropped once its monitor disappears", async () => {
	const t = await mirroring()
	try {
		await t.click("DP-1")
		t.state.monitors = [monitor("eDP-1"), monitor("DP-1", { disabled: true })]
		t.handlers.get("monitor-removed")!()
		await tick()
		t.state.monitors = [
			monitor("eDP-1"),
			monitor("DP-1", { x: 77, mirrorOf: "eDP-1" }),
		]
		t.handlers.get("monitor-added")!()
		await tick()
		await t.click("DP-1")
		assert.match(t.messages.at(-1)!, /position = "77x0".*mirror = "none"/)
	} finally {
		t.restore()
	}
})

test("snapshots survive a remount and only the open menu refreshes", async () => {
	const t = await mirroring({ opened: "" })
	try {
		assert.deepEqual(t.reads, [])
		t.open("wifi-selector")
		await tick()
		assert.deepEqual(t.reads, [])
		t.open("mirror-selector")
		await tick()
		assert.equal(t.reads.length, 1)
		await t.click("DP-1")
		t.cleanups.shift()!()
		assert.equal(t.handlers.size, 0)
		assert.equal(t.subscribers.length, 0)
		const reads = t.reads.length
		t.open("mirror-selector")
		await tick()
		assert.equal(t.reads.length, reads)
		await t.remount()
		t.state.monitors = [
			monitor("eDP-1"),
			monitor("DP-1", { x: 5, mirrorOf: "eDP-1" }),
		]
		t.handlers.get("monitor-added")!()
		await tick()
		await t.click("DP-1")
		assert.match(t.messages.at(-1)!, /position = "1920x0".*mirror = "none"/)
	} finally {
		t.restore()
	}
})

test("only the latest monitor read updates the list", async () => {
	const t = await mirroring()
	try {
		const pending: ((value: string) => void)[] = []
		t.state.read = () => new Promise((resolve) => pending.push(resolve))
		t.handlers.get("monitor-added")!()
		t.handlers.get("monitor-removed")!()
		pending[1](
			JSON.stringify([monitor("eDP-1"), monitor("HDMI-A-1", { x: 1 })]),
		)
		await tick()
		pending[0](JSON.stringify([monitor("eDP-1"), monitor("DP-9")]))
		await tick()
		assert.deepEqual(t.labels(), ["External (HDMI-A-1) "])
		t.cleanups.shift()!()
		t.handlers.clear()
	} finally {
		t.restore()
	}
})

test("toggle opens the mirror menu and entries scale their icon", async () => {
	const t = await mirroring({ scale: 150 })
	try {
		const toggle = t.DisplayMirroring.Toggle()
		assert.equal(toggle.props.connection(), true)
		toggle.props.onToggle()
		assert.equal(toggle.props.connection(), false)
		const image = nodes(t.buttons()[0]).find((node) => node.type === "image")
		assert.equal(image.props.pixelSize(), 24)
		assert.equal(image.props.iconName, icons.default.ui.projector)
	} finally {
		t.restore()
	}
})

test("a click that finishes after unmount does not update the list", async () => {
	const t = await mirroring()
	try {
		let release: () => void = () => {}
		const read = t.state.read
		t.state.read = () => {
			const reply = read()
			return new Promise((resolve) => {
				release = () => resolve(reply)
			})
		}
		t.buttons()[0].props.onClicked()
		await tick()
		t.cleanups.shift()!()
		t.state.read = read
		t.state.monitors = [monitor("eDP-1"), monitor("HDMI-A-1")]
		release()
		await tick()
		await tick()
		assert.equal(t.messages.length, 1)
		assert.deepEqual(t.labels(), ["External (DP-1) "])
	} finally {
		t.restore()
	}
})
