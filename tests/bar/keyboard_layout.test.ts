import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { with_hyprland_command } from "../hyprland.ts"
import * as result from "../../lib/result.ts"
import * as icons from "../../lib/icons.ts"
import { accessor, create_state, nodes, tick } from "../helpers.ts"

type node = { type: unknown; props: Record<string, any> }

function devices(keymap) {
	return {
		keyboards: [
			{ name: "auxiliary", main: false, active_keymap: "Russian" },
			{ name: "main", main: true, active_keymap: keymap },
		],
	}
}

function stub_namespace(name: string): any {
	return new Proxy(() => ({ type: name, props: {} }), {
		get: (_target, key) =>
			typeof key === "string" ? stub_namespace(`${name}.${key}`) : undefined,
	})
}

function emitter() {
	const handlers = new Map<number, [string, (...args: unknown[]) => void]>()
	let serial = 0
	return {
		handlers,
		connect(signal: string, callback: (...args: unknown[]) => void) {
			handlers.set(++serial, [signal, callback])
			return serial
		},
		disconnect(id: number) {
			assert.equal(handlers.delete(id), true)
		},
		emit(signal: string, ...args: unknown[]) {
			for (const [name, callback] of [...handlers.values()])
				if (name === signal) callback(...args)
		},
		count(signal: string) {
			return [...handlers.values()].filter(([name]) => name === signal).length
		},
	}
}

function monitor(height: number) {
	const output = {
		...emitter(),
		height,
		get_geometry: () => ({ height: output.height }),
	}
	return output
}

async function quicksettings_fixture() {
	const requests: {
		resolve: (value: string) => void
		reject: (reason: Error) => void
	}[] = []
	const keyboard = emitter()
	const cleanups: (() => void)[] = []
	const labels: node[] = []
	const errors: unknown[][] = []
	const popups: node[] = []
	const app = {
		...emitter(),
		monitors: [monitor(1080), monitor(900)],
		get_monitors: () => app.monitors,
	}
	const speaker = {
		volume: 0.5 as number | null,
		mute: false,
		get_volume: () => speaker.volume,
		set_volume: (value: number) => {
			speaker.volume = value
		},
		get_mute: () => speaker.mute,
		set_mute: (value: boolean) => {
			speaker.mute = value
		},
	}
	const audio = { speaker: speaker as typeof speaker | null }
	const brightness = {
		display: 0.6,
		displayAvailable: true,
		requests: [] as number[],
		failure: null as Error | null,
		async set_display(value: number) {
			brightness.requests.push(value)
			if (brightness.failure) return result.err(brightness.failure)
			brightness.display = value
			return result.ok(undefined)
		},
	}
	const daemon = {
		dontDisturb: false,
		get_dont_disturb: () => daemon.dontDisturb,
		set_dont_disturb: (value: boolean) => {
			daemon.dontDisturb = value
		},
	}
	let scheme_value = "dark"
	const scheme = Object.assign(
		accessor(() => scheme_value),
		{
			set: (value: string) => {
				scheme_value = value
			},
		},
	)
	const watched: { path: string; callback: () => void; cancelled: boolean }[] =
		[]
	let monitor_failure: Error | null = null
	const make = (type, props: Record<string, any> = {}) => {
		if (typeof type === "function") return type(props)
		const node = { type, props }
		if (type === "label") labels.push(node)
		return node
	}
	const imports = {
		ags: {
			createState: create_state,
			createBinding: (object, property) => accessor(() => object[property]),
			createComputed: (fn) => accessor(fn),
			For: (props) => make("for", props),
			onCleanup: (fn) => cleanups.push(fn),
		},
		"ags/file": {
			monitorFile: (path: string, callback: () => void) => {
				if (monitor_failure) throw monitor_failure
				const watch = { path, callback, cancelled: false }
				watched.push(watch)
				return {
					cancel: () => {
						watch.cancelled = true
					},
				}
			},
		},
		"ags/gtk4": {
			Astal: { Exclusivity: { EXCLUSIVE: 1 } },
			Gdk: { BUTTON_MIDDLE: 2 },
			Gtk: {
				Align: { CENTER: 1 },
				Orientation: { VERTICAL: 1 },
				EventControllerScrollFlags: { VERTICAL: 1 },
				ContentFit: { COVER: 1 },
				PolicyType: { NEVER: 0, AUTOMATIC: 1 },
				EventControllerScroll: "scroll",
				GestureClick: "gesture",
				Picture: "picture",
				ScrolledWindow: "scrolled",
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"gi://AstalMpris": {
			default: { get_default: () => ({ players: [] }) },
		},
		"gi://AstalWp": {
			default: {
				get_default: () => ({ get_default_speaker: () => audio.speaker }),
			},
		},
		"$lib/app": { default: app },
		"widget/Settings": { Settings: stub_namespace("Settings") },
		"widget/Bar/components/PanelButton": {
			PanelButton: (props) => make("panel", props),
		},
		"widget/shared/PopupWindow": {
			create_popup_position: () => ({}),
			PopupWindow: (props) => {
				const popup = make("popup", props)
				popups.push(popup)
				return popup
			},
		},
		"./components/Network": { Network: stub_namespace("Network") },
		"./components/Audio": { Audio: stub_namespace("Audio") },
		"./components/MenuControls": {
			ToggleButton: (props) => make("toggle", props),
		},
		"./components/Bluetooth": { Bluetooth: stub_namespace("Bluetooth") },
		"./components/DisplayMirroring": {
			DisplayMirroring: stub_namespace("DisplayMirroring"),
		},
		"./components/MediaPlayer": { MediaPlayer: stub_namespace("MediaPlayer") },
		"./components/PowerProfiles": {
			PowerProfiles: stub_namespace("PowerProfiles"),
		},
		"$lib/env": {
			default: { paths: { avatar: "/home/me/.face" }, username: "me" },
		},
		"$lib/textures": {
			texture_from_file_square_contain: (path: string, size: number) =>
				`${path}@${size}`,
		},
		"$lib/hyprland": with_hyprland_command({
			hyprland: {
				connect: (signal, callback) => {
					assert.equal(signal, "keyboard-layout")
					return keyboard.connect(signal, callback)
				},
				disconnect: (id) => keyboard.disconnect(id),
				message_async: (message) => {
					assert.equal(message, "j/devices")
					return new Promise((resolve, reject) =>
						requests.push({ resolve, reject }),
					)
				},
			},
		}),
		"$lib/notifications": { notification_daemon: daemon },
		"$service/brightness": { brightness },
		"$shell/options": {
			default: {
				bar: {},
				quicksettings: { width: accessor(() => 400) },
				theme: { scheme },
				scale: accessor(() => 150),
			},
			ui_scale: () => 1.5,
		},
	}
	const module = await load_module(
		"widget/Bar/components/QuickSettings/index.tsx",
		imports,
	)
	await tick()
	const original_error = console.error
	console.error = (...args) => errors.push(args)
	return {
		QuickSettings: module.QuickSettings,
		requests,
		keyboard,
		errors,
		cleanups,
		app,
		audio,
		speaker,
		brightness,
		daemon,
		scheme: () => scheme_value,
		watched,
		popups,
		fail_monitor: (error: Error) => {
			monitor_failure = error
		},
		restore: () => {
			console.error = original_error
		},
		mount: () => {
			module.QuickSettings.Button()
			return labels.at(-1)!.props.label
		},
		unmount: () => cleanups.shift()!(),
		emit: (name, layout) =>
			keyboard.emit("keyboard-layout", null, name, layout),
		complete: async (index, data) => {
			requests[index].resolve(JSON.stringify(data))
			await tick()
		},
	}
}

function keyboard_test(
	name: string,
	body: (f: Awaited<ReturnType<typeof quicksettings_fixture>>) => Promise<void>,
) {
	test(name, async () => {
		const f = await quicksettings_fixture()
		try {
			await body(f)
		} finally {
			f.restore()
		}
	})
}

keyboard_test(
	"layout events re-query the main keyboard instead of displaying event error or none",
	async (f) => {
		const label = f.mount()
		await f.complete(0, devices("English (US)"))
		assert.equal(label(), "en")
		for (const [index, payload, keymap, code] of [
			[1, "error", "Russian", "ru"],
			[2, "none", "Hebrew", "he"],
			[3, "English (US)", "English (US)", "en"],
		] as [number, string, string, string][]) {
			f.emit("main", payload)
			assert.equal(f.requests.length, index + 1)
			await f.complete(index, devices(keymap))
			assert.equal(label(), code)
		}
		f.emit("auxiliary", "Russian")
		await f.complete(4, devices("English (US)"))
		assert.equal(label(), "en")
		f.emit("main", "x")
		await f.complete(5, devices("Klingon (tlh)"))
		assert.equal(label(), "klingon")
		f.emit("main", "x")
		await f.complete(6, devices("(intl)"))
		assert.equal(label(), "unk")
		assert.equal(f.errors.length, 0)
	},
)

keyboard_test(
	"invalid device layouts and failed reads retain the last good label and report failure",
	async (f) => {
		const label = f.mount()
		await f.complete(0, devices("English (US)"))
		const invalid = [
			devices("error"),
			devices("none"),
			devices(" Error "),
			devices(" NONE "),
			devices("  "),
			devices(""),
			devices(undefined),
			devices(123),
			{ keyboards: [] },
			{ keyboards: [null] },
			{ keyboards: "main" },
			{ keyboards: 5 },
			{},
			{ keyboards: [{ main: 0, active_keymap: "German" }] },
			[devices("German")],
			"text",
			null,
		]
		for (const [index, data] of invalid.entries()) {
			f.emit("main", "error")
			await f.complete(index + 1, data)
			assert.equal(label(), "en")
			assert.equal(f.errors.length, index + 1)
		}
		assert.deepEqual(
			f.errors.slice(0, 9).map((args) => args[1]),
			[
				"Invalid main keyboard layout: error",
				"Invalid main keyboard layout: none",
				"Invalid main keyboard layout: error",
				"Invalid main keyboard layout: none",
				"Invalid main keyboard layout: ",
				"Invalid main keyboard layout: ",
				"Main keyboard has no active keymap",
				"Main keyboard has no active keymap",
				"No main keyboard layout",
			],
		)
		assert.ok(
			f.errors.every(
				(args) => args[0] === "keyboard_layout.read: Failed to read layout",
			),
		)
		f.emit("main", "none")
		f.requests.at(-1)!.resolve("not JSON")
		await tick()
		assert.equal(label(), "en")
		assert.ok(f.errors.at(-1)![1] instanceof SyntaxError)
		f.emit("main", "none")
		const unavailable = new Error("hyprctl unavailable")
		f.requests.at(-1)!.reject(unavailable)
		await tick()
		assert.equal(label(), "en")
		assert.equal(f.errors.at(-1)![1], unavailable)
		assert.equal(f.errors.length, invalid.length + 2)
		f.emit("replacement-keyboard", "error")
		await f.complete(f.requests.length - 1, devices("Hebrew"))
		assert.equal(label(), "he")
	},
)

keyboard_test("startup failure recovers when a keyboard appears", async (f) => {
	const label = f.mount()
	await f.complete(0, { keyboards: [] })
	assert.equal(label(), "")
	assert.equal(f.errors.length, 1)
	f.emit("new-keyboard", "none")
	await f.complete(1, devices("Russian"))
	assert.equal(label(), "ru")
})

keyboard_test(
	"only the latest layout query updates shared monitor labels",
	async (f) => {
		const first = f.mount()
		const second = f.mount()
		assert.equal(f.requests.length, 1)
		assert.equal(f.keyboard.handlers.size, 1)
		f.emit("main", "Russian")
		f.emit("main", "Hebrew")
		await f.complete(2, devices("Hebrew"))
		await f.complete(1, devices("Russian"))
		await f.complete(0, devices("English (US)"))
		assert.equal(first(), "he")
		assert.equal(second(), "he")
		f.unmount()
		assert.equal(f.keyboard.handlers.size, 1)
		f.emit("main", "English (US)")
		await f.complete(3, devices("English (US)"))
		assert.equal(second(), "en")
		f.unmount()
		assert.equal(f.keyboard.handlers.size, 0)
	},
)

keyboard_test(
	"unmount invalidates pending queries even after remount",
	async (f) => {
		f.mount()
		f.unmount()
		const label = f.mount()
		await f.complete(1, devices("Russian"))
		await f.complete(0, devices("English (US)"))
		assert.equal(label(), "ru")
	},
)

keyboard_test(
	"latest failure retains the prior layout and obsolete failures do not log",
	async (f) => {
		const label = f.mount()
		await f.complete(0, devices("English (US)"))
		f.emit("main", "Russian")
		f.emit("main", "Hebrew")
		f.requests[2].reject(new Error("latest read failed"))
		await tick()
		await f.complete(1, devices("Russian"))
		assert.equal(label(), "en")
		assert.equal(f.errors.length, 1)
		f.emit("main", "Russian")
		f.emit("main", "Hebrew")
		await f.complete(4, devices("Hebrew"))
		f.requests[3].reject(new Error("obsolete read failed"))
		await tick()
		assert.equal(label(), "he")
		assert.equal(f.errors.length, 1)
		f.emit("main", "English (US)")
		f.unmount()
		f.requests[5].reject(new Error("unmounted read failed"))
		await tick()
		assert.equal(label(), "he")
		assert.equal(f.errors.length, 1)
	},
)

keyboard_test(
	"panel scroll nudges the speaker volume and middle click mutes",
	async (f) => {
		f.mount()
		const panel = f.QuickSettings.Button()
		const scroll = nodes(panel).find((node) => node.type === "scroll")!
		const gesture = nodes(panel).find((node) => node.type === "gesture")!
		assert.equal(scroll.props.onScroll(null, 0, 4), true)
		assert.equal(f.speaker.volume, 0.4)
		assert.equal(scroll.props.onScroll(null, 0, -100), true)
		assert.equal(f.speaker.volume, 1)
		scroll.props.onScroll(null, 0, 100)
		assert.equal(f.speaker.volume, 0)
		f.speaker.volume = null
		scroll.props.onScroll(null, 0, -2)
		assert.equal(f.speaker.volume, 0.05)
		let resets = 0
		const press = (button: number) =>
			gesture.props.onPressed({
				get_current_button: () => button,
				reset: () => resets++,
			})
		press(1)
		assert.equal(f.speaker.mute, false)
		press(2)
		assert.equal(f.speaker.mute, true)
		press(2)
		assert.equal(f.speaker.mute, false)
		f.audio.speaker = null
		assert.equal(scroll.props.onScroll(null, 0, 1), true)
		press(2)
		assert.equal(resets, 4)
	},
)

function window_parts(f: Awaited<ReturnType<typeof quicksettings_fixture>>) {
	f.QuickSettings.Window()
	const popup = f.popups.at(-1)!
	const all = nodes(popup)
	const unit = all.find((node) => node.props.class === "control-unit")!
	return {
		all,
		scrolled: all.find((node) => node.type === "scrolled")!,
		content: all.find((node) => node.props.class === "quicksettings vertical")!,
		avatar: all.find((node) => node.type === "picture")!,
		brightness: {
			unit,
			button: nodes(unit).find((node) => node.type === "button")!,
			image: nodes(unit).find((node) => node.type === "image")!,
			slider: nodes(unit).find((node) => node.type === "slider")!,
		},
		toggles: all.filter((node) => node.type === "toggle"),
	}
}

keyboard_test(
	"brightness mute restores the last level and logs failed writes",
	async (f) => {
		const { brightness } = window_parts(f)
		assert.equal(brightness.unit.props.visible(), true)
		assert.equal(
			brightness.button.props.tooltipText(),
			"Screen Brightness: 60% ",
		)
		assert.equal(
			brightness.image.props.iconName(),
			icons.get_brightness_icon(0.6, "screen"),
		)
		brightness.button.props.onClicked()
		await tick()
		assert.equal(f.brightness.display, 0)
		brightness.button.props.onClicked()
		await tick()
		assert.deepEqual(f.brightness.requests, [0, 0.6])
		brightness.slider.props.onChangeValue({ value: 0.3 })
		await tick()
		brightness.button.props.onClicked()
		await tick()
		brightness.button.props.onClicked()
		await tick()
		assert.deepEqual(f.brightness.requests, [0, 0.6, 0.3, 0, 0.3])
		const failure = new Error("backlight")
		f.brightness.failure = failure
		brightness.button.props.onClicked()
		await tick()
		brightness.button.props.onClicked()
		await tick()
		brightness.slider.props.onChangeValue({ value: 0.9 })
		await tick()
		assert.deepEqual(f.brightness.requests.slice(5), [0, 0, 0.9])
		assert.deepEqual(f.errors, [
			["brightness.toggle:", failure],
			["brightness.toggle:", failure],
			["brightness.slider:", failure],
		])
	},
)

keyboard_test(
	"popup height follows the shortest monitor and rewires on hotplug",
	async (f) => {
		const window = window_parts(f)
		const [first, second] = f.app.monitors
		assert.equal(window.scrolled.props.maxContentHeight(), 900 - 144)
		assert.equal(window.content.props.css(), "min-width: 600px;")
		assert.equal(f.app.count("notify::monitors"), 1)
		assert.equal(first.count("notify::geometry"), 1)
		second.height = 600
		second.emit("notify::geometry")
		assert.equal(window.scrolled.props.maxContentHeight(), 600 - 144)
		const third = monitor(300)
		f.app.monitors = [first, third]
		f.app.emit("notify::monitors")
		assert.equal(second.count("notify::geometry"), 0)
		assert.equal(first.count("notify::geometry"), 1)
		assert.equal(third.count("notify::geometry"), 1)
		assert.equal(window.scrolled.props.maxContentHeight(), 200)
		f.app.monitors = []
		f.app.emit("notify::monitors")
		assert.equal(window.scrolled.props.maxContentHeight(), 1080 - 144)
		f.app.monitors = [first]
		f.app.emit("notify::monitors")
		for (const cleanup of f.cleanups.splice(0)) cleanup()
		assert.equal(f.app.count("notify::monitors"), 0)
		assert.equal(first.count("notify::geometry"), 0)
	},
)

keyboard_test(
	"avatar follows its file and the theme and silence toggles flip state",
	async (f) => {
		const failure = new Error("inotify")
		f.fail_monitor(failure)
		const broken = window_parts(f)
		const picture = { paintable: null as unknown }
		broken.avatar.props.$(picture)
		assert.equal(picture.paintable, "/home/me/.face@84")
		assert.deepEqual(f.errors, [
			["quicksettings.avatar: Failed to watch avatar", failure],
		])
		f.cleanups.at(-1)!()
		f.fail_monitor(null as unknown as Error)
		const window = window_parts(f)
		window.avatar.props.$(picture)
		assert.equal(window.avatar.props.widthRequest(), 84)
		assert.equal(f.watched[0].path, "/home/me/.face")
		picture.paintable = null
		f.watched[0].callback()
		assert.equal(picture.paintable, "/home/me/.face@84")
		f.cleanups.at(-1)!()
		assert.equal(f.watched[0].cancelled, true)

		const [dark, silence] = window.toggles
		assert.equal(dark.props.label(), "Dark")
		assert.equal(dark.props.iconName(), icons.default.color.dark)
		dark.props.onToggle()
		assert.equal(f.scheme(), "light")
		assert.equal(dark.props.label(), "Light")
		assert.equal(dark.props.connection(), false)
		dark.props.onToggle()
		assert.equal(f.scheme(), "dark")
		assert.equal(silence.props.label(), "Normal")
		silence.props.onToggle()
		assert.equal(f.daemon.dontDisturb, true)
		assert.equal(silence.props.label(), "Silent")
		assert.equal(silence.props.iconName(), icons.default.notifications.silent)
	},
)
