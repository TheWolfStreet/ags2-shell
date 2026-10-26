import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as result from "../../lib/result.ts"
import * as icons from "../../lib/icons.ts"
import {
	accessor,
	create_binding,
	glib_clock as fake_glib,
	for_node,
	with_node,
	subscribe_list,
	on_shutdown,
	create_state,
	jsx_runtime,
	make,
	nodes,
	read,
	tick,
	type node,
} from "../helpers.ts"

const icon = icons.default

function find(root, predicate: (node: node) => boolean) {
	const found = nodes(root).find(predicate)
	assert.ok(found)
	return found
}

async function capture_errors() {
	await tick()
	const errors: unknown[][] = []
	const original = console.error
	console.error = (...args) => errors.push(args)
	return {
		errors,
		restore: () => {
			console.error = original
		},
	}
}

function ags(cleanups: (() => void)[] = []) {
	return {
		createBinding: create_binding,
		createComputed: accessor,
		createState: create_state,
		onCleanup: (fn: () => void) => cleanups.push(fn),
		With: with_node,
		For: for_node,
	}
}

async function menu_controls() {
	const toggles: ((window: { visible: boolean }) => void)[] = []
	const exec: { argv: string[]; fail?: Error }[] = []
	let fail: Error | null = null
	const {
		Menu,
		ToggleButton,
		Arrow,
		SettingsButton,
		open_gnome_settings,
		quick_settings_submenu,
	} = await load_module(
		"widget/Bar/components/QuickSettings/components/MenuControls.tsx",
		{
			ags: { ...ags(), Node: null },
			"ags/gtk4": {
				Gtk: {
					RevealerTransitionType: { SLIDE_DOWN: 1 },
					Orientation: { VERTICAL: 1 },
					Align: { CENTER: 1 },
					Separator: "separator",
				},
			},
			"ags/gtk4/jsx-runtime": jsx_runtime,
			"ags/process": {
				execAsync: async (argv: string[]) => {
					exec.push({ argv })
					if (fail) throw fail
					return ""
				},
			},
			"gi://Pango": { default: { EllipsizeMode: { END: 3 } } },
			"$lib/ui": {},
			"$lib/windowing": {
				on_window_toggle: (_name, callback) => toggles.push(callback),
			},
			"$shell/options": { default: { transition: { duration: 7 } } },
		},
	)
	return {
		Menu,
		ToggleButton,
		Arrow,
		SettingsButton,
		open_gnome_settings,
		quick_settings_submenu,
		exec,
		fail: (error: Error) => {
			fail = error
		},
		window: (visible: boolean) => {
			for (const toggle of toggles) toggle({ visible })
		},
	}
}

test("menus reveal by name and the quicksettings window closes them", async () => {
	const m = await menu_controls()
	const { quick_settings_submenu: submenu } = m
	const menu = m.Menu({ name: "wifi", title: "Wi-Fi", iconName: "net" })
	const unnamed = m.Menu({ title: "Plain" })
	const box = find(menu, (node) => node.type === "box")
	assert.equal(box.props.class, "menu wifi")
	assert.equal(
		find(unnamed, (node) => node.type === "box").props.class,
		"menu ",
	)
	assert.equal(menu.props.transitionDuration, 7)
	assert.equal(menu.props.revealChild(), false)
	assert.equal(unnamed.props.revealChild(), true)
	submenu.toggle("wifi")
	assert.equal(menu.props.revealChild(), true)
	assert.equal(unnamed.props.revealChild(), false)
	submenu.toggle("wifi")
	assert.equal(submenu.opened.peek(), "")
	submenu.toggle("wifi")
	m.window(true)
	assert.equal(submenu.opened.peek(), "wifi")
	m.window(false)
	assert.equal(submenu.opened.peek(), "")
	const { toggle } = submenu
	toggle("bt")
	assert.equal(submenu.opened.peek(), "bt")
	submenu.close()
	assert.equal(submenu.opened.peek(), "")
})

test("toggle buttons reflect their connection and arrows open their menu", async () => {
	const m = await menu_controls()
	let active = false
	const arrows: string[] = []
	const button = m.ToggleButton({
		name: "bt",
		label: "Bluetooth",
		iconName: "bt-icon",
		connection: accessor(() => active),
		onToggle: () => {},
		onArrow: () => arrows.push(m.quick_settings_submenu.opened.peek()),
		arrow: true,
	})
	assert.equal(button.props.class(), "toggle-button")
	active = true
	assert.equal(button.props.class(), "toggle-button active")
	const [main, arrow] = nodes(button).filter((node) => node.type === "button")
	assert.equal(main.props.sensitive, true)
	assert.equal(main.props.tooltipText, "Bluetooth")
	assert.equal(arrow.props.class, "arrow")
	assert.equal(arrow.props.visible, true)
	assert.equal(arrow.props.tooltipText, "")
	const image = find(arrow, (node) => node.type === "image")
	assert.equal(image.props.css(), "transform: rotate(0deg);")
	arrow.props.onClicked()
	assert.deepEqual(arrows, ["bt"])
	assert.equal(image.props.css(), "transform: rotate(90deg);")
	const simple = m.ToggleButton({ label: "Plain" })
	assert.equal(simple.props.class, "simple-toggle")
	assert.equal(nodes(simple).filter((node) => node.type === "button").length, 1)
	assert.equal(
		find(simple, (node) => node.type === "button").props.sensitive,
		false,
	)
	const bare = m.Arrow({ tooltipText: "Mixer" })
	bare.props.onClicked()
	assert.equal(m.quick_settings_submenu.opened.peek(), "bt")
	assert.equal(bare.props.tooltipText, "Mixer")
})

test("gnome settings launch through the GNOME desktop and log failures", async () => {
	const m = await menu_controls()
	const log = await capture_errors()
	try {
		m.open_gnome_settings("wifi")
		await tick()
		const failure = new Error("missing")
		m.fail(failure)
		m.open_gnome_settings("bluetooth")
		await tick()
		assert.deepEqual(
			m.exec.map(({ argv }) => argv),
			[
				["env", "XDG_CURRENT_DESKTOP=GNOME", "gnome-control-center", "wifi"],
				[
					"env",
					"XDG_CURRENT_DESKTOP=GNOME",
					"gnome-control-center",
					"bluetooth",
				],
			],
		)
		assert.deepEqual(log.errors, [
			["quicksettings.settings: Failed to open bluetooth settings", failure],
		])
		const settings = m.SettingsButton({ callback: () => {} })
		assert.equal(
			find(settings, (node) => node.type === "label").props.label,
			"Settings",
		)
	} finally {
		log.restore()
	}
})

class Endpoint {
	media_class: number
	description: string
	name: string
	icon = "audio-card-analog"
	volume = 0.5
	mute = true
	volumeIcon = "vol"
	defaults: boolean[] = []
	constructor(media_class: number, name: string, description = "") {
		this.media_class = media_class
		this.name = name
		this.description = description
	}
	get_media_class() {
		return this.media_class
	}
	get_mute() {
		return this.mute
	}
	set_mute(mute: boolean) {
		this.mute = mute
	}
	set_volume(volume: number) {
		this.volume = volume
	}
	set_is_default(value: boolean) {
		this.defaults.push(value)
	}
}

const STREAM = 1
const SINK = 2
const SOURCE = 3

async function audio_fixture() {
	const sink = new Endpoint(SINK, "speaker", "Built-in Audio Analog Stereo Out")
	const plain_sink = Object.assign(new Endpoint(SINK, "plain"), {
		plain: true,
	})
	Object.setPrototypeOf(plain_sink, {
		get_media_class: () => SINK,
	})
	const stream = new Endpoint(STREAM, "firefox", "Firefox")
	const mic = new Endpoint(SOURCE, "mic")
	const audio = {
		nodes: [sink, plain_sink, stream, mic] as unknown[] | null,
		defaultSpeaker: sink as Endpoint | null,
		defaultMicrophone: mic as Endpoint | null,
		devices: [mic] as unknown[] | null,
	}
	const exec: string[][] = []
	let available = true
	const { Audio } = await load_module(
		"widget/Bar/components/QuickSettings/components/Audio.tsx",
		{
			"ags/gtk4": {
				Gtk: {
					Align: { CENTER: 1, END: 2 },
					Orientation: { VERTICAL: 1 },
					Separator: "separator",
				},
			},
			"ags/process": {
				execAsync: async (argv: string[]) => {
					exec.push(argv)
					throw new Error("pavucontrol crashed")
				},
			},
			ags: ags(),
			"ags/gtk4/jsx-runtime": jsx_runtime,
			"gi://AstalWp": {
				default: {
					get_default: () => audio,
					Endpoint,
					MediaClass: { STREAM_OUTPUT_AUDIO: STREAM, AUDIO_SINK: SINK },
				},
			},
			"gi://Pango": { default: { EllipsizeMode: { END: 3 } } },
			"./MenuControls": {
				Arrow: (props) => make("arrow", props),
				Menu: (props) => make("menu", props),
				SettingsButton: (props) => make("settings", props),
			},
			"$lib/notifications": { notify_missing_programs: () => available },
			"$lib/ui": {},
		},
	)
	return {
		Audio,
		audio,
		sink,
		stream,
		mic,
		exec,
		set_available: (value: boolean) => {
			available = value
		},
	}
}

test("audio menus list streams and sink endpoints and open pavucontrol", async () => {
	const a = await audio_fixture()
	const log = await capture_errors()
	try {
		const mixer = a.Audio.AppMixer()
		assert.equal(mixer.props.name, "app-mixer")
		assert.equal(mixer.props.iconName, icon.audio.mixer)
		const stream_labels = nodes(mixer)
			.filter((node) => node.type === "label")
			.map((node) => read(node.props.label))
		assert.deepEqual(stream_labels, ["firefox"])
		const slider = find(mixer, (node) => node.type === "slider")
		slider.props.onChangeValue({ value: 0.25 })
		assert.equal(a.stream.volume, 0.25)
		assert.equal(a.stream.mute, true)
		const mixer_icon = find(mixer, (node) => node.type === "image")
		assert.equal(mixer_icon.props.tooltipText(), "Firefox")
		a.stream.description = ""
		assert.equal(mixer_icon.props.tooltipText(), "")

		const sinks = a.Audio.SinkSelector()
		assert.equal(sinks.props.name, "device-selector")
		const sink_buttons = nodes(sinks).filter((node) => node.type === "button")
		assert.equal(sink_buttons.length, 1)
		assert.equal(
			find(sink_buttons[0], (node) => node.type === "label").props.label,
			"Built-in Audio Analog Stereo",
		)
		const [device_icon, tick_icon] = nodes(sink_buttons[0]).filter(
			(node) => node.type === "image",
		)
		assert.equal(device_icon.props.iconName(), "audio-card-symbolic")
		assert.equal(device_icon.props.tooltipText(), "speaker")
		assert.equal(tick_icon.props.visible(), true)
		a.audio.defaultSpeaker = null
		assert.equal(tick_icon.props.visible(), false)
		sink_buttons[0].props.onClicked()
		assert.deepEqual(a.sink.defaults, [true])
		a.audio.nodes = null
		assert.equal(
			nodes(a.Audio.SinkSelector()).filter((n) => n.type === "button").length,
			0,
		)

		for (const menu of [mixer, sinks])
			find(menu, (node) => node.type === "settings").props.callback()
		await tick()
		a.set_available(false)
		find(mixer, (node) => node.type === "settings").props.callback()
		await tick()
		assert.deepEqual(a.exec, [["pavucontrol"], ["pavucontrol"]])
		assert.deepEqual(
			log.errors.map(([tag]) => tag),
			[
				"audio.settings: Failed to open pavucontrol",
				"audio.settings: Failed to open pavucontrol",
			],
		)
	} finally {
		log.restore()
	}
})

test("volume controls show arrows per node kind and unmute on change", async () => {
	const a = await audio_fixture()
	const volume = a.Audio.Sliders.Volume()
	const arrows = nodes(volume).filter((node) => node.type === "arrow")
	const holder = find(volume, (node) => node.props.class === "volume")
	assert.deepEqual(
		arrows.map((arrow) => [arrow.props.name, arrow.props.tooltipText]),
		[
			["device-selector", "Device Selector"],
			["app-mixer", "App Mixer"],
		],
	)
	assert.equal(holder.props.visible(), true)
	assert.equal(arrows[1].props.visible(), true)
	a.audio.nodes = [a.sink]
	assert.equal(arrows[1].props.visible(), false)
	a.audio.nodes = [a.stream]
	assert.equal(holder.props.visible(), false)
	assert.equal(arrows[1].props.visible(), true)
	a.audio.nodes = null
	assert.equal(holder.props.visible(), false)

	const unit = find(volume, (node) => node.props.class === "control-unit")
	assert.equal(unit.props.visible, true)
	const button = find(unit, (node) => node.type === "button")
	assert.equal(button.props.tooltipText(), "Volume: 50%")
	button.props.onClicked()
	assert.equal(a.sink.mute, false)
	button.props.onClicked()
	const slider = find(unit, (node) => node.type === "slider")
	assert.equal(slider.props.class(), "muted")
	slider.props.onChangeValue({ value: 0.8 })
	assert.equal(a.sink.volume, 0.8)
	assert.equal(a.sink.mute, false)
	assert.equal(slider.props.class(), "")
	assert.equal(slider.props.value(), 0.8)
	assert.equal(button.props.tooltipText(), "Volume: 80%")

	const mic = a.Audio.Sliders.Microphone()
	const mic_unit = find(mic, (node) => node.props.class === "control-unit")
	assert.equal(mic_unit.props.visible(), true)
	a.audio.devices = []
	assert.equal(mic_unit.props.visible(), false)
	a.audio.devices = null
	assert.equal(mic_unit.props.visible(), false)
	a.audio.defaultMicrophone = null
	const empty = find(
		a.Audio.Sliders.Microphone(),
		(node) => node.type === "box",
	)
	assert.equal(empty.props.visible, false)
})

test("audio state icons follow the default endpoints", async () => {
	const a = await audio_fixture()
	const speaker = find(a.Audio.State.Speaker(), (node) => node.type === "image")
	assert.equal(speaker.props.iconName(), "vol")
	a.audio.defaultMicrophone = null
	const mic = find(a.Audio.State.Microphone(), (node) => node.type === "box")
	assert.equal(mic.props.visible, false)
})

async function bluetooth_fixture() {
	const cleanups: (() => void)[] = []
	const window_toggles: ((window: { visible: boolean }) => void)[] = []
	const opened = { name: "bluetooth-selector" }
	const opened_subscribers: (() => void)[] = []
	const exec: string[][] = []
	let available = true
	let exec_failure: Error | null = null
	const adapter = {
		powered: true,
		discovering: false,
		calls: [] as string[],
		fail: null as Error | null,
		set_powered(value: boolean) {
			this.calls.push(`powered:${value}`)
			if (this.fail) throw this.fail
			this.powered = value
		},
		start_discovery() {
			this.calls.push("start")
			this.discovering = true
		},
		stop_discovery() {
			this.calls.push("stop")
			if (this.fail) throw this.fail
			this.discovering = false
		},
	}
	const bluetooth = {
		isPowered: true,
		isConnected: false,
		adapters: [adapter] as unknown[],
		adapter: adapter as typeof adapter | null,
		devices: [] as unknown[],
		get_adapter: () => bluetooth.adapter,
	}
	const { Bluetooth } = await load_module(
		"widget/Bar/components/QuickSettings/components/Bluetooth.tsx",
		{
			"ags/gtk4": {
				Gtk: {
					Orientation: { VERTICAL: 1 },
					Align: { CENTER: 1 },
					ScrolledWindow: "scroll",
					Separator: "separator",
					GestureClick: "gesture",
					Spinner: "spinner",
				},
				Gdk: { BUTTON_PRIMARY: 1, BUTTON_SECONDARY: 3 },
			},
			ags: ags(cleanups),
			"ags/gtk4/jsx-runtime": jsx_runtime,
			"ags/process": {
				execAsync: async (argv: string[]) => {
					exec.push(argv)
					if (exec_failure) throw exec_failure
					return ""
				},
			},
			"gi://AstalBluetooth": { default: { get_default: () => bluetooth } },
			"widget/Bar/components/QuickSettings/components/MenuControls": {
				ToggleButton: (props) => make("toggle", props),
				Menu: (props) => make("menu", props),
				SettingsButton: (props) => make("settings", props),
				open_gnome_settings: () => {},
				quick_settings_submenu: {
					opened: Object.assign(
						accessor(() => opened.name),
						{
							subscribe: subscribe_list(opened_subscribers),
						},
					),
				},
			},
			"widget/shared/Placeholder": {
				Placeholder: (props) => make("placeholder", props),
			},
			"$lib/notifications": { notify_missing_programs: () => available },
			"$lib/windowing": {
				on_window_toggle: (_name, callback) => {
					window_toggles.push(callback)
					return () => {}
				},
			},
			"$shell/options": { default: { transition: { duration: 0 } } },
		},
	)
	return {
		Bluetooth,
		bluetooth,
		adapter,
		exec,
		cleanups,
		set_available: (value: boolean) => {
			available = value
		},
		fail_exec: (error: Error) => {
			exec_failure = error
		},
		open: (name: string) => {
			opened.name = name
			for (const subscriber of opened_subscribers) subscriber()
		},
		window: (visible: boolean) => {
			for (const toggle of window_toggles) toggle({ visible })
		},
	}
}

function bluetooth_device(fields: Record<string, unknown> = {}) {
	const device = {
		name: "Headset",
		address: "AA:BB",
		icon: "audio-headset",
		connected: false,
		connecting: false,
		paired: true,
		batteryPercentage: 0.456,
		calls: [] as string[],
		start_failure: null as Error | null,
		finish_failure: null as Error | null,
		get_connected() {
			return this.connected
		},
		get_address() {
			return this.address
		},
		connect_device(callback) {
			this.calls.push("connect")
			if (this.start_failure) throw this.start_failure
			callback(this, "connect-result")
		},
		connect_device_finish(res: string) {
			this.calls.push(`finish:${res}`)
			if (this.finish_failure) throw this.finish_failure
		},
		disconnect_device(callback) {
			this.calls.push("disconnect")
			if (this.start_failure) throw this.start_failure
			callback(this, "disconnect-result")
		},
		disconnect_device_finish(res: string) {
			this.calls.push(`finish:${res}`)
			if (this.finish_failure) throw this.finish_failure
		},
		...fields,
	}
	return device
}

function press(entry, button: number) {
	const gesture = find(entry, (node) => node.type === "gesture")
	let resets = 0
	gesture.props.onPressed({
		get_current_button: () => button,
		reset: () => resets++,
	})
	return resets
}

test("bluetooth toggle label and power follow the adapter state", async () => {
	const b = await bluetooth_fixture()
	const log = await capture_errors()
	try {
		const toggle = b.Bluetooth.Toggle()
		assert.equal(toggle.props.label(), "Not Connected")
		assert.equal(toggle.props.iconName(), icon.bluetooth.enabled)
		const headset = bluetooth_device({ connected: true })
		b.bluetooth.devices = [bluetooth_device({ name: "Mouse" }), headset]
		b.bluetooth.isConnected = true
		assert.equal(toggle.props.label(), "Headset")
		b.bluetooth.isPowered = false
		assert.equal(toggle.props.label(), "Disabled")
		assert.equal(toggle.props.iconName(), icon.bluetooth.disabled)
		b.bluetooth.adapters = []
		assert.equal(toggle.props.label(), "No Device")
		toggle.props.onArrow()
		toggle.props.onToggle()
		assert.deepEqual(b.adapter.calls, ["powered:true", "powered:true"])
		b.bluetooth.isPowered = true
		toggle.props.onArrow()
		toggle.props.onToggle()
		assert.deepEqual(b.adapter.calls.slice(2), ["powered:false"])
		const failure = new Error("rfkill")
		b.adapter.fail = failure
		toggle.props.onToggle()
		assert.deepEqual(log.errors, [
			["bluetooth.power: Failed to change power", failure],
		])
		b.bluetooth.adapter = null
		toggle.props.onToggle()
		assert.equal(b.adapter.calls.length, 4)
	} finally {
		log.restore()
	}
})

test("bluetooth entries connect, disconnect and unpair by mouse button", async () => {
	const b = await bluetooth_fixture()
	const log = await capture_errors()
	try {
		const device = bluetooth_device()
		b.bluetooth.devices = [device]
		const entry = () =>
			find(
				b.Bluetooth.Selector(),
				(node) => node.type === "button" && "tooltipText" in node.props,
			)
		assert.equal(press(entry(), 1), 1)
		device.connected = true
		press(entry(), 1)
		assert.deepEqual(device.calls, [
			"connect",
			"finish:connect-result",
			"disconnect",
			"finish:disconnect-result",
		])
		const finish = new Error("finish")
		device.finish_failure = finish
		press(entry(), 1)
		device.connected = false
		press(entry(), 1)
		device.finish_failure = null
		const start = new Error("start")
		device.start_failure = start
		press(entry(), 1)
		device.connected = true
		press(entry(), 1)
		assert.deepEqual(log.errors, [
			["bluetooth.device: Failed to disconnect", finish],
			["bluetooth.device: Failed to connect", finish],
			["bluetooth.device: Failed to start connection", start],
			["bluetooth.device: Failed to start disconnect", start],
		])
		log.errors.length = 0
		assert.equal(press(entry(), 3), 1)
		await tick()
		b.set_available(false)
		press(entry(), 3)
		b.set_available(true)
		device.paired = false
		press(entry(), 3)
		device.paired = true
		const unpair = new Error("unpair")
		b.fail_exec(unpair)
		press(entry(), 3)
		await tick()
		assert.equal(press(entry(), 2), 1)
		assert.deepEqual(b.exec, [
			["bluetoothctl", "remove", "AA:BB"],
			["bluetoothctl", "remove", "AA:BB"],
		])
		assert.deepEqual(log.errors, [
			["bluetooth.device: Failed to unpair", unpair],
		])
	} finally {
		log.restore()
	}
})

test("bluetooth entries list named devices first with paired battery details", async () => {
	const b = await bluetooth_fixture()
	b.bluetooth.devices = [
		bluetooth_device({ name: "", address: "11", paired: false }),
		bluetooth_device({ name: "  ", address: "22", batteryPercentage: -1 }),
		bluetooth_device({ name: "Keyboard", connected: true }),
		bluetooth_device({ name: null, address: "33", connecting: true }),
		bluetooth_device({ name: "Mouse", batteryPercentage: undefined }),
	]
	const entries = nodes(b.Bluetooth.Selector()).filter(
		(node) => node.type === "button" && "tooltipText" in node.props,
	)
	const labels = entries.map((entry) =>
		nodes(entry)
			.filter((node) => node.type === "label")
			.map((node) => read(node.props.label)),
	)
	assert.deepEqual(labels, [
		["Keyboard • Paired", "46%"],
		["Mouse • Paired", ""],
		["11", ""],
		["   • Paired", ""],
		["33 • Paired", "46%"],
	])
	assert.deepEqual(
		entries.map((entry) => [entry.props.class(), entry.props.tooltipText()]),
		[
			["active", "Right-click to unpair"],
			["", "Right-click to unpair"],
			["", ""],
			["", "Right-click to unpair"],
			["", "Right-click to unpair"],
		],
	)
	const details = entries.map((entry) =>
		find(entry, (node) => node.props.class === "device-detail").props.visible(),
	)
	assert.deepEqual(details, [true, false, false, false, true])
	assert.equal(
		find(entries[4], (node) => node.type === "spinner").props.visible(),
		true,
	)
	assert.equal(
		find(entries[0], (node) => node.type === "image").props.iconName(),
		"audio-headset-symbolic",
	)
})

test("bluetooth scans it started stop when the menu or window closes", async () => {
	const b = await bluetooth_fixture()
	const log = await capture_errors()
	try {
		const selector = b.Bluetooth.Selector()
		const scan = () =>
			find(
				selector,
				(node) => node.type === "button" && node.props.$type === "end",
			)
		const label = () =>
			find(scan(), (node) => node.type === "label").props.label()
		assert.equal(label(), "Scan")
		b.adapter.powered = false
		scan().props.onClicked()
		assert.deepEqual(b.adapter.calls, ["powered:true", "start"])
		assert.equal(label(), "Cancel")
		b.open("wifi-selector")
		assert.deepEqual(b.adapter.calls.slice(2), ["stop"])
		b.open("bluetooth-selector")
		b.open("wifi-selector")
		assert.equal(b.adapter.calls.length, 3)
		scan().props.onClicked()
		b.window(true)
		b.window(false)
		assert.deepEqual(b.adapter.calls.slice(3), ["start", "stop"])
		b.adapter.discovering = true
		b.open("wifi-selector")
		assert.equal(b.adapter.calls.length, 5)
		scan().props.onClicked()
		assert.deepEqual(b.adapter.calls.slice(5), ["stop"])
		scan().props.onClicked()
		const failure = new Error("busy")
		b.adapter.fail = failure
		b.cleanups.forEach((cleanup) => cleanup())
		scan().props.onClicked()
		assert.deepEqual(b.adapter.calls.slice(6), ["start", "stop", "stop"])
		assert.deepEqual(log.errors, [
			["bluetooth.discovery: Failed to stop scan", failure],
			["bluetooth.discovery: Failed to change scan state", failure],
		])
		b.bluetooth.adapter = null
		const empty = b.Bluetooth.Selector()
		assert.equal(
			find(empty, (node) => node.type === "placeholder").props.label,
			"No Device Found",
		)
	} finally {
		log.restore()
	}
})

class Variant {
	value: unknown
	constructor(value: unknown) {
		this.value = value
	}
	lookup_value(key: string) {
		if (key !== "mpris:length" || this.value === undefined) return null
		return { deepUnpack: () => this.value }
	}
}

const PLAYING = 0
const PAUSED = 1
const LOOP = { NONE: 0, TRACK: 1, PLAYLIST: 2, UNSUPPORTED: 3 }
const SHUFFLE = { ON: 0, OFF: 1, UNSUPPORTED: 2 }

async function media_fixture() {
	const cleanups: (() => void)[] = []
	const clock = fake_glib()
	const time = await load_module("lib/time.ts", {
		"gi://GLib": { default: clock.glib },
	})
	const { MediaPlayer } = await load_module(
		"widget/Bar/components/QuickSettings/components/MediaPlayer.tsx",
		{
			"ags/gtk4": {
				Gtk: {
					Align: { START: 0, CENTER: 1, END: 2 },
					Orientation: { VERTICAL: 1 },
					ContentFit: { COVER: 1 },
					Picture: "picture",
				},
				Gdk: {},
			},
			ags: ags(cleanups),
			"ags/gtk4/jsx-runtime": jsx_runtime,
			"$lib/time": time,
			"gi://AstalMpris": {
				default: {
					PlaybackStatus: { PLAYING, PAUSED },
					Loop: LOOP,
					Shuffle: SHUFFLE,
				},
			},
			"gi://GLib": { default: {} },
			"gi://Pango": { default: { EllipsizeMode: { END: 3 } } },
			"$lib/textures": {
				create_texture_accessor: (uri: string, size: number) =>
					accessor(() => (uri ? `${uri}@${size}` : null)),
			},
			"$shell/options": { scaled: (px: number) => accessor(() => px) },
		},
	)
	return { MediaPlayer, clock, cleanups }
}

function player(fields: Record<string, unknown> = {}) {
	return {
		title: "Song",
		artist: "Band",
		coverArt: "",
		artUrl: "",
		entry: "spotify",
		position: 30,
		length: -1,
		metadata: new Variant(undefined),
		trackid: "/t/1",
		playbackStatus: PLAYING,
		loopStatus: LOOP.NONE,
		shuffleStatus: SHUFFLE.OFF,
		canControl: true,
		canGoNext: true,
		canGoPrevious: false,
		canSeek: true,
		calls: [] as string[],
		set_loop_status(status: number) {
			this.loopStatus = status
		},
		set_shuffle_status(status: number) {
			this.shuffleStatus = status
		},
		previous() {
			this.calls.push("previous")
		},
		play_pause() {
			this.calls.push("play_pause")
		},
		next() {
			this.calls.push("next")
		},
		...fields,
	}
}

function media_parts(root) {
	const buttons = nodes(root).filter((node) => node.type === "button")
	return {
		root,
		slider: find(root, (node) => node.type === "slider"),
		position: find(root, (node) => node.props.class === "position"),
		remaining: find(root, (node) => node.props.class === "length"),
		cover: find(root, (node) => node.type === "picture"),
		shuffle: buttons[0],
		previous: buttons[1],
		play: buttons[2],
		next: buttons[3],
		loop: buttons[4],
		icon: (button) =>
			read(find(button, (node) => node.type === "image").props.iconName),
	}
}

test("media controls cycle loop and shuffle and forward transport", async () => {
	const m = await media_fixture()
	const p = player()
	const ui = media_parts(m.MediaPlayer({ player: p }))
	const loop_state = () => [
		ui.loop.props.class(),
		ui.loop.props.tooltipText(),
		ui.icon(ui.loop),
	]
	assert.deepEqual(loop_state(), ["", "Loop: Disabled", icon.mpris.loop.none])
	ui.loop.props.onClicked()
	assert.equal(p.loopStatus, LOOP.PLAYLIST)
	assert.deepEqual(loop_state(), [
		"active",
		"Loop: Playlist",
		icon.mpris.loop.playlist,
	])
	ui.loop.props.onClicked()
	assert.equal(p.loopStatus, LOOP.TRACK)
	assert.deepEqual(loop_state(), [
		"active",
		"Loop: Track",
		icon.mpris.loop.track,
	])
	ui.loop.props.onClicked()
	assert.equal(p.loopStatus, LOOP.NONE)
	assert.equal(ui.loop.props.visible(), true)
	p.loopStatus = LOOP.UNSUPPORTED
	ui.loop.props.onClicked()
	assert.equal(p.loopStatus, LOOP.UNSUPPORTED)
	assert.deepEqual(loop_state(), ["", "Loop: Disabled", icon.mpris.loop.none])
	assert.equal(ui.loop.props.visible(), false)

	assert.equal(ui.shuffle.props.class(), "")
	ui.shuffle.props.onClicked()
	assert.equal(p.shuffleStatus, SHUFFLE.ON)
	assert.equal(ui.shuffle.props.class(), "active")
	ui.shuffle.props.onClicked()
	assert.equal(p.shuffleStatus, SHUFFLE.OFF)
	assert.equal(ui.shuffle.props.visible(), true)
	p.shuffleStatus = SHUFFLE.UNSUPPORTED
	ui.shuffle.props.onClicked()
	assert.equal(p.shuffleStatus, SHUFFLE.UNSUPPORTED)
	assert.equal(ui.shuffle.props.visible(), false)

	assert.equal(ui.icon(ui.play), icon.mpris.playing)
	p.playbackStatus = PAUSED
	assert.equal(ui.icon(ui.play), icon.mpris.paused)
	ui.previous.props.onClicked()
	ui.play.props.onClicked()
	ui.next.props.onClicked()
	assert.deepEqual(p.calls, ["previous", "play_pause", "next"])
	assert.deepEqual(
		[
			ui.previous.props.visible(),
			ui.play.props.visible(),
			ui.next.props.visible(),
		],
		[false, true, true],
	)
	const labels = nodes(ui.root)
		.filter((node) => node.type === "label")
		.map((node) => read(node.props.label))
	assert.deepEqual(labels.slice(0, 2), ["Song", "Band"])
	p.title = ""
	p.artist = ""
	p.entry = ""
	const fallback = nodes(ui.root).filter((node) => node.type === "label")
	assert.deepEqual(
		fallback.slice(0, 2).map((node) => read(node.props.label)),
		["Untitled", "Unknown Artist"],
	)
	assert.equal(
		read(find(ui.root, (node) => node.type === "image").props.iconName),
		icon.fallback.audio,
	)
})

test("media length prefers the longest report and is remembered per track", async () => {
	const m = await media_fixture()
	const p = player({ length: 100, metadata: new Variant(250_000_000) })
	const ui = media_parts(m.MediaPlayer({ player: p }))
	assert.equal(ui.slider.props.tooltipText(), "Duration: 4:10")
	assert.equal(ui.slider.props.visible(), true)
	assert.equal(ui.remaining.props.label(), "3:40")
	assert.equal(ui.position.props.label(), "0:30")
	assert.equal(ui.slider.props.value(), 30 / 250)
	assert.equal(ui.slider.props.sensitive(), true)
	p.length = -1
	p.metadata = new Variant(undefined)
	assert.equal(ui.slider.props.tooltipText(), "Duration: 4:10")
	p.trackid = "/t/2"
	assert.equal(ui.slider.props.tooltipText(), "Duration unavailable")
	assert.deepEqual(
		[
			ui.slider.props.visible(),
			ui.position.props.visible(),
			ui.remaining.props.visible(),
			ui.slider.props.sensitive(),
			ui.slider.props.value(),
		],
		[false, false, false, false, 0],
	)
	p.metadata = new Variant("bogus")
	assert.equal(ui.slider.props.tooltipText(), "Duration unavailable")
	p.trackid = "/t/1"
	assert.equal(ui.slider.props.tooltipText(), "Duration: 4:10")
	p.canSeek = false
	assert.equal(ui.slider.props.sensitive(), false)

	const again = media_parts(m.MediaPlayer({ player: player({ length: -1 }) }))
	assert.equal(again.slider.props.tooltipText(), "Duration: 4:10")
	const fresh = media_parts(
		m.MediaPlayer({ player: player({ trackid: "/t/9", length: 60 }) }),
	)
	assert.equal(fresh.slider.props.tooltipText(), "Duration: 1:00")
	p.position = 400
	assert.equal(ui.slider.props.value(), 1)
	assert.equal(ui.remaining.props.label(), "0:00")
	p.position = -5
	assert.equal(ui.slider.props.value(), 0)
})

test("media cover art prefers the art url and hides without a texture", async () => {
	const m = await media_fixture()
	const p = player({ coverArt: "file:///cover.png" })
	const ui = media_parts(m.MediaPlayer({ player: p }))
	assert.equal(ui.cover.props.paintable(), "file:///cover.png@128")
	assert.equal(ui.cover.props.visible(), true)
	p.artUrl = "https://art"
	assert.equal(ui.cover.props.paintable(), "https://art@128")
	p.artUrl = ""
	p.coverArt = ""
	assert.equal(ui.cover.props.visible(), false)
})

test("media seeking debounces and holds the dragged position until it settles", async () => {
	const m = await media_fixture()
	const p = player({ length: 200 })
	const ui = media_parts(m.MediaPlayer({ player: p }))
	ui.slider.props.onChangeValue({ value: 0.5 })
	assert.equal(ui.slider.props.value(), 0.5)
	assert.equal(p.position, 30)
	m.clock.run(60)
	assert.equal(p.position, 100)
	assert.equal(ui.slider.props.value(), 0.5)
	m.clock.run(1500)
	assert.equal(ui.slider.props.value(), 0.5)
	ui.slider.props.onChangeValue({ value: 0.25 })
	m.clock.run(1500)
	assert.equal(ui.slider.props.value(), 0.5)
	m.clock.run(60)
	assert.equal(p.position, 50)
	m.cleanups.forEach((cleanup) => cleanup())
	assert.equal(m.clock.sources.size, 0)
})

async function power_fixture({ asus = false, in_path = true } = {}) {
	const cleanups: (() => void)[] = []
	const watchers: { appear: () => void; vanish: () => void }[] = []
	const unwatched: number[] = []
	const shutdown: (() => void)[] = []
	const window_toggles: ((window: { visible: boolean }) => void)[] = []
	const launched: string[][] = []
	let launch_failure: Error | null = null
	let programs = true
	const asusctl = {
		available: asus,
		profile: "Quiet",
		profiles: ["Quiet", "Balanced", "Performance"],
		mode: "Integrated",
		selected: [] as string[],
		refreshes: 0,
		failure: null as Error | null,
		async refresh() {
			this.refreshes++
			return this.failure ? result.err(this.failure) : result.ok(undefined)
		},
		async set_profile(profile: string) {
			this.selected.push(profile)
			return this.failure ? result.err(this.failure) : result.ok(undefined)
		},
	}
	const daemon = {
		construct_failure: null as Error | null,
		version: "0.21" as string | (() => string),
		profiles: ["power-saver", "balanced", "performance"] as
			string[] | (() => string[]),
		activeProfile: "balanced",
		selected: [] as string[],
		select_failure: null as Error | null,
		handlers: new Map<number, string>(),
		serial: 0,
	}
	class PowerProfilesService {
		constructor() {
			if (daemon.construct_failure) throw daemon.construct_failure
		}
		get activeProfile() {
			return daemon.activeProfile
		}
		get_version() {
			return typeof daemon.version === "function"
				? daemon.version()
				: daemon.version
		}
		get_profiles() {
			const profiles =
				typeof daemon.profiles === "function"
					? daemon.profiles()
					: daemon.profiles
			return profiles.map((profile) => ({ profile }))
		}
		set_active_profile(profile: string) {
			if (daemon.select_failure) throw daemon.select_failure
			daemon.selected.push(profile)
			daemon.activeProfile = profile
		}
		connect(signal: string) {
			daemon.handlers.set(++daemon.serial, signal)
			return daemon.serial
		}
		disconnect(id: number) {
			assert.ok(daemon.handlers.delete(id))
		}
	}
	const { PowerProfiles } = await load_module(
		"widget/Bar/components/QuickSettings/components/PowerProfiles.tsx",
		{
			"$lib/app": {
				default: {
					connect: on_shutdown(shutdown),
				},
			},
			"ags/gtk4": { Gtk: { Orientation: { VERTICAL: 1 }, Separator: "sep" } },
			"ags/gtk4/jsx-runtime": jsx_runtime,
			ags: ags(cleanups),
			"gi://AstalPowerProfiles": {
				default: { PowerProfiles: PowerProfilesService },
			},
			"gi://Gio": {
				default: {
					BusType: { SYSTEM: 0 },
					BusNameWatcherFlags: { NONE: 0 },
					bus_watch_name: (_bus, name, _flags, appear, vanish) => {
						assert.equal(name, "org.freedesktop.UPower.PowerProfiles")
						watchers.push({ appear, vanish })
						return 42
					},
					bus_unwatch_name: (id: number) => unwatched.push(id),
				},
			},
			"gi://GLib": {
				default: {
					find_program_in_path: (name: string) => {
						assert.equal(name, "asusctl")
						return in_path ? "/bin/asusctl" : null
					},
				},
			},
			"widget/Bar/components/QuickSettings/components/MenuControls": {
				ToggleButton: (props) => make("toggle", props),
				Menu: (props) => make("menu", props),
				SettingsButton: (props) => make("settings", props),
			},
			"widget/shared/Placeholder": {
				Placeholder: (props) => make("placeholder", props),
			},
			"$lib/apps": {
				launch_program: async (argv: string[]) => {
					launched.push(argv)
					return launch_failure
						? result.err(launch_failure)
						: result.ok(undefined)
				},
			},
			"$lib/notifications": { notify_missing_programs: () => programs },
			"$service/asusctl": { asusctl },
			"$service/sleep_inhibitor": {
				sleep_inhibitor: { inhibited: accessor(() => false), toggle: () => {} },
			},
			"$lib/windowing": {
				on_window_toggle: (_name, callback) => {
					window_toggles.push(callback)
					return () => {}
				},
			},
		},
	)
	const toggle = () =>
		find(PowerProfiles.Toggle(), (node) => node.type === "toggle")
	const selector = () =>
		find(PowerProfiles.Selector(), (node) => node.type === "menu")
	return {
		PowerProfiles,
		asusctl,
		daemon,
		watchers,
		unwatched,
		shutdown,
		cleanups,
		launched,
		toggle,
		selector,
		profile_buttons: () =>
			nodes(selector())
				.filter((node) => node.type === "button" && !node.props.$type)
				.map((button) => ({
					label: find(button, (node) => node.type === "label").props.label,
					icon: find(button, (node) => node.type === "image").props.iconName,
					click: () => button.props.onClicked(),
				})),
		window: (visible: boolean) => {
			for (const toggle of window_toggles) toggle({ visible })
		},
		appear: () => watchers[0].appear(),
		vanish: () => watchers[0].vanish(),
		set_programs: (value: boolean) => {
			programs = value
		},
		fail_launch: (error: Error) => {
			launch_failure = error
		},
	}
}

test("power profiles daemon drives the toggle, selector and state icon", async () => {
	const p = await power_fixture()
	const log = await capture_errors()
	try {
		assert.equal(p.toggle().props.label, "No Provider")
		assert.equal(p.toggle().props.name, "missing-profile")
		assert.equal(
			p.selector().props.title,
			"Install asusctl or powerprofiles daemon",
		)
		p.appear()
		assert.deepEqual(
			[...p.daemon.handlers.values()],
			["notify::version", "notify::profiles"],
		)
		const toggle = p.toggle()
		assert.equal(toggle.props.name, "profile-selector")
		assert.equal(toggle.props.label(), "Balanced")
		assert.equal(toggle.props.iconName(), icon.powerprofile.balanced)
		assert.equal(toggle.props.connection(), false)
		const state = () =>
			find(p.PowerProfiles.State.Power(), (node) => node.type === "image")
		assert.equal(state().props.visible(), false)
		toggle.props.onToggle()
		assert.deepEqual(p.daemon.selected, ["power-saver"])
		assert.equal(toggle.props.label(), "Power Saver")
		assert.equal(toggle.props.connection(), true)
		assert.equal(state().props.visible(), true)
		assert.equal(state().props.iconName(), icon.powerprofile["power-saver"])
		toggle.props.onToggle()
		assert.deepEqual(p.daemon.selected, ["power-saver", "balanced"])
		const buttons = p.profile_buttons()
		assert.deepEqual(
			buttons.map(({ label, icon }) => [label, icon]),
			[
				["Power Saver", icon.powerprofile["power-saver"]],
				["Balanced", icon.powerprofile.balanced],
				["Performance", icon.powerprofile.performance],
			],
		)
		buttons[2].click()
		assert.equal(p.daemon.activeProfile, "performance")
		assert.equal(
			nodes(p.selector()).some((node) => node.type === "settings"),
			false,
		)
		const failure = new Error("denied")
		p.daemon.select_failure = failure
		buttons[0].click()
		assert.deepEqual(log.errors, [["power_profiles.select:", failure]])
		p.vanish()
		assert.equal(p.daemon.handlers.size, 0)
		assert.equal(p.toggle().props.label, "No Provider")
		p.shutdown.forEach((callback) => callback())
		assert.deepEqual(p.unwatched, [42])
	} finally {
		log.restore()
	}
})

test("power toggle defaults fall back to the available profiles", async () => {
	const p = await power_fixture()
	const log = await capture_errors()
	try {
		p.appear()
		p.daemon.profiles = ["performance", "eco"]
		p.daemon.activeProfile = "performance"
		const toggle = p.toggle()
		assert.equal(toggle.props.connection(), false)
		toggle.props.onToggle()
		assert.equal(p.daemon.activeProfile, "eco")
		assert.equal(toggle.props.label(), "Eco")
		p.daemon.profiles = ["performance"]
		assert.equal(p.toggle().props.onToggle, undefined)
		p.daemon.profiles = ["balanced", "turbo-boost"]
		p.daemon.activeProfile = "balanced"
		p.toggle().props.onToggle()
		assert.equal(p.daemon.activeProfile, "turbo-boost")
		assert.equal(p.toggle().props.label(), "Turbo Boost")
		assert.equal(p.toggle().props.iconName(), icon.missing)
		const failure = new Error("dbus")
		p.daemon.profiles = () => {
			throw failure
		}
		assert.equal(p.toggle().props.onToggle, undefined)
		assert.deepEqual(p.profile_buttons(), [])
		assert.deepEqual(
			log.errors.map(([tag]) => tag),
			Array(log.errors.length).fill("power_profiles.profiles:"),
		)
		assert.ok(log.errors.length > 0)
		assert.equal(log.errors[0][1], failure)
	} finally {
		log.restore()
	}
})

test("power profiles daemon failures leave no provider and are logged", async () => {
	const p = await power_fixture()
	const log = await capture_errors()
	try {
		const construct = new Error("no bus")
		p.daemon.construct_failure = construct
		p.appear()
		p.daemon.construct_failure = null
		const version = new Error("no version")
		p.daemon.version = () => {
			throw version
		}
		p.appear()
		assert.deepEqual(log.errors, [
			["power_profiles.connect:", construct],
			["power_profiles.version:", version],
		])
		assert.equal(p.daemon.handlers.size, 0)
		assert.equal(p.toggle().props.label, "No Provider")
		p.daemon.version = ""
		p.appear()
		assert.equal(p.toggle().props.label, "No Provider")
		p.daemon.version = "1"
		p.appear()
		assert.equal(p.toggle().props.label(), "Balanced")
		p.daemon.version = () => {
			throw version
		}
		log.errors.length = 0
		assert.equal(p.toggle().props.label, "No Provider")
		assert.deepEqual(log.errors, [["power_profiles.provider:", version]])
	} finally {
		log.restore()
	}
})

test("asusctl takes precedence with its profiles, settings and mode icon", async () => {
	const p = await power_fixture({ asus: true })
	const log = await capture_errors()
	try {
		p.appear()
		const toggle = p.toggle()
		assert.equal(toggle.props.label(), "Quiet")
		assert.equal(toggle.props.iconName(), icon.asusctl.profile.Quiet)
		assert.equal(toggle.props.connection(), true)
		toggle.props.onToggle()
		p.asusctl.profile = "Balanced"
		toggle.props.onToggle()
		assert.deepEqual(p.asusctl.selected, ["Balanced", "Quiet"])
		assert.deepEqual(
			p.profile_buttons().map(({ label }) => label),
			["Quiet", "Balanced", "Performance"],
		)
		const failure = new Error("asusd")
		p.asusctl.failure = failure
		p.profile_buttons()[2].click()
		await tick()
		const settings = () =>
			find(p.selector(), (node) => node.type === "settings")
		settings().props.callback()
		await tick()
		const launch = new Error("no rog")
		p.fail_launch(launch)
		settings().props.callback()
		await tick()
		p.set_programs(false)
		settings().props.callback()
		await tick()
		assert.deepEqual(p.launched, [
			["rog-control-center"],
			["rog-control-center"],
		])
		assert.deepEqual(log.errors, [
			["power_profiles.select:", failure],
			["power_profiles: Could not open settings", launch],
		])
		const mode = () =>
			find(p.PowerProfiles.State.Asus(), (node) => node.type === "image")
		assert.equal(mode().props.visible(), true)
		assert.equal(mode().props.iconName(), icon.asusctl.mode.Integrated)
		p.asusctl.mode = "Hybrid"
		assert.equal(mode().props.visible(), false)
		p.asusctl.mode = "Unknown"
		assert.equal(mode().props.iconName(), icon.missing)
		p.asusctl.available = false
		p.asusctl.mode = "Integrated"
		assert.equal(mode().props.visible(), false)
		assert.equal(p.toggle().props.label(), "Balanced")
	} finally {
		log.restore()
	}
})

test("opening quicksettings refreshes asusctl only when it is installed", async () => {
	const log = await capture_errors()
	try {
		const installed = await power_fixture({ asus: true })
		installed.selector()
		installed.window(false)
		installed.window(true)
		await tick()
		assert.equal(installed.asusctl.refreshes, 1)
		const failure = new Error("asusd down")
		installed.asusctl.failure = failure
		installed.window(true)
		await tick()
		assert.deepEqual(log.errors, [["power_profiles.refresh:", failure]])
		const missing = await power_fixture({ in_path: false })
		missing.selector()
		missing.window(true)
		await tick()
		assert.equal(missing.asusctl.refreshes, 0)
	} finally {
		log.restore()
	}
})
