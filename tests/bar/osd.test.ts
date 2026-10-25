import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { accessor, jsx_runtime, make, nodes } from "../helpers.ts"

function signals() {
	const handlers = new Map<number, [string, () => void]>()
	let next = 0
	return {
		handlers,
		connect(signal: string, fn: () => void) {
			next++
			handlers.set(next, [signal, fn])
			return next
		},
		disconnect(id: number) {
			handlers.delete(id)
		},
		emit(signal: string) {
			for (const [name, fn] of [...handlers.values()]) if (name === signal) fn()
		},
	}
}

function endpoint(volume: number, icon: string, mute = false) {
	return {
		...signals(),
		volume,
		mute,
		get_volume() {
			return this.volume
		},
		get_volume_icon: () => icon,
		get_mute() {
			return this.mute
		},
	}
}

async function osd_fixture() {
	const speaker = { current: endpoint(0.5, "speaker") as any }
	const microphone = { current: endpoint(0.2, "mic") as any }
	const audio = {
		...signals(),
		get_default_speaker: () => speaker.current,
		get_default_microphone: () => microphone.current,
	}
	const brightness = {
		...signals(),
		initialized: false,
		display: 0.4,
		kbd: 0.6,
	}
	const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
	const cleanups: (() => void)[] = []
	const states: { value: any }[] = []
	const module = await load_module("widget/OSD/index.tsx", {
		"$lib/app": { default: { name: "app" } },
		"ags/gtk4": {
			Astal: {
				Layer: { OVERLAY: 3 },
				Exclusivity: { IGNORE: 2 },
				Keymode: { NONE: 0 },
			},
			Gtk: {
				Orientation: { VERTICAL: 1 },
				AspectFrame: "aspect",
				ProgressBar: "progress",
			},
		},
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"$lib/time": {
			timeout: (ms, fn) => {
				const timer = { ms, fn, cancelled: false }
				timers.push(timer)
				return {
					cancel: () => {
						timer.cancelled = true
					},
				}
			},
		},
		ags: {
			createState: (initial) => {
				const state = { value: initial }
				states.push(state)
				return [
					accessor(() => state.value),
					(next) => {
						state.value = next
					},
				]
			},
			onCleanup: (fn) => cleanups.push(fn),
		},
		"gi://AstalWp": { default: { get_default: () => audio } },
		"widget/shared/PopupWindow": {
			PopupWindow: (props) => make("popup", props),
		},
		"$service/brightness": { brightness },
		"$lib/icons": {
			get_brightness_icon: (value, kind) => `${kind}:${value}`,
		},
		"$lib/windowing": { ignore_input: () => {} },
		"$shell/options": {
			default: {
				osd: { position: "bottom-center", dismiss: { peek: () => 1500 } },
			},
			scaled: (value) => value,
		},
	})
	const [reveal, content] = states
	return {
		module,
		audio,
		speaker,
		microphone,
		brightness,
		timers,
		cleanups,
		reveal: () => reveal.value,
		content: () => content.value,
	}
}

test("the window is built once and renders the current content", async () => {
	const f = await osd_fixture()
	const window = f.module.OSD.Window()
	assert.equal(f.module.OSD.Window(), window)
	assert.equal(window.props.name, "state-display")
	assert.equal(window.props.keymode, 0)
	assert.equal(window.props.layer, 3)
	assert.equal(window.props.layout, "bottom-center")
	const bar = nodes(window, "progress")[0]
	const image = nodes(window, "image")[0]
	f.speaker.current.volume = 1.4
	f.speaker.current.emit("notify::volume")
	assert.equal(bar.props.fraction(), 1)
	assert.equal(bar.props.class(), "percentage")
	assert.equal(image.props.iconName(), "speaker")
	f.speaker.current.volume = Number.NaN
	f.speaker.current.mute = true
	f.speaker.current.emit("notify::mute")
	assert.equal(bar.props.fraction(), 0)
	assert.equal(bar.props.class(), "percentage muted")
	f.speaker.current.volume = -1
	f.speaker.current.emit("notify::volume")
	assert.equal(bar.props.fraction(), 0)
})

test("volume changes reveal the OSD and restart the dismiss timer", async () => {
	const f = await osd_fixture()
	f.module.OSD.Window()
	f.microphone.current.emit("notify::volume")
	assert.deepEqual(f.content(), { value: 0.2, icon: "mic", muted: false })
	assert.equal(f.reveal(), true)
	assert.equal(f.timers[0].ms, 1500)
	f.speaker.current.emit("notify::volume")
	assert.equal(f.timers[0].cancelled, true)
	f.timers[1].fn()
	assert.equal(f.reveal(), false)
})

test("a new default endpoint replaces the watched one", async () => {
	const f = await osd_fixture()
	f.module.OSD.Window()
	const old = f.speaker.current
	f.speaker.current = endpoint(0.9, "headset")
	f.audio.emit("notify::default-speaker")
	assert.equal(old.handlers.size, 0)
	old.emit("notify::volume")
	assert.equal(f.timers.length, 0)
	f.speaker.current.emit("notify::volume")
	assert.deepEqual(f.content(), { value: 0.9, icon: "headset", muted: false })
	f.speaker.current = null
	f.audio.emit("notify::default-speaker")
	assert.equal(f.timers.length, 1)
})

test("brightness shows only after the service is initialized", async () => {
	const f = await osd_fixture()
	f.module.OSD.Window()
	f.brightness.emit("notify::display")
	f.brightness.emit("notify::kbd")
	assert.equal(f.timers.length, 0)
	f.brightness.initialized = true
	f.brightness.emit("notify::display")
	assert.deepEqual(f.content(), {
		value: 0.4,
		icon: "screen:0.4",
		muted: false,
	})
	f.brightness.emit("notify::kbd")
	assert.deepEqual(f.content(), {
		value: 0.6,
		icon: "keyboard:0.6",
		muted: false,
	})
})

test("cleanup disconnects everything and allows a fresh window", async () => {
	const f = await osd_fixture()
	const window = f.module.OSD.Window()
	f.speaker.current.emit("notify::volume")
	for (const cleanup of f.cleanups) cleanup()
	assert.equal(f.timers[0].cancelled, true)
	assert.equal(f.audio.handlers.size, 0)
	assert.equal(f.brightness.handlers.size, 0)
	assert.equal(f.speaker.current.handlers.size, 0)
	assert.equal(f.microphone.current.handlers.size, 0)
	assert.notEqual(f.module.OSD.Window(), window)
})
