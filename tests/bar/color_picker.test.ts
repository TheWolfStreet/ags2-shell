import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { load_module } from "../load_module.ts"
import { create_state, jsx_runtime, make, nodes, tick } from "../helpers.ts"

type fake_copy = { content: unknown; finish: (copied?: boolean) => void }
type fixture_options = {
	history?: unknown
	raw?: string
	max?: number
	history_size?: number
	history_exists?: boolean
	position?: string
	picked?: () => Promise<string>
	missing?: () => boolean
	notify_result?: (count: number) => unknown
	write?: (data: string) => Promise<void>
	ensure?: () => unknown
}

async function color_picker_fixture({
	history = [],
	raw,
	max = 100,
	history_size = 5000,
	history_exists = true,
	position = "top-center",
	picked = async () => "#abcdef",
	missing = () => true,
	notify_result = (count) => ({ ok: true, value: count }),
	write = async () => {},
	ensure = () => ({ ok: true, value: undefined }),
}: fixture_options = {}) {
	const copies: fake_copy[] = []
	const errors: unknown[][] = []
	const warnings: unknown[][] = []
	const notifications: any[] = []
	const writes: string[][] = []
	const reads: string[] = []
	const missing_checks: string[][] = []
	const positions: number[] = []
	const idles: (() => void)[] = []
	const cleanups: (() => void)[] = []
	const popover_calls: string[] = []
	const popovers: any[] = []
	const revealers: any[] = []
	let revealer_child
	let colors
	const [max_colors, set_max] = create_state(max)
	const [bar_position, set_position] = create_state(position)
	mock.method(console, "error", (...args) => errors.push(args))
	mock.method(console, "warn", (...args) => warnings.push(args))
	class Popover {
		handlers = new Map<string, () => void>()
		constructor() {
			popovers.push(this)
		}
		connect(name: string, handler: () => void) {
			this.handlers.set(name, handler)
			return 7
		}
		disconnect(id: number) {
			popover_calls.push(`disconnect:${id}`)
		}
		emit(name: string) {
			this.handlers.get(name)?.()
		}
		set_has_arrow() {}
		add_css_class() {}
		set_child() {}
		set_focusable() {}
		set_position(value) {
			positions.push(value)
		}
		set_parent() {
			popover_calls.push("parent")
		}
		unparent() {
			popover_calls.push("unparent")
		}
		popup() {
			popover_calls.push("popup")
		}
		popdown() {
			popover_calls.push("popdown")
		}
		get_root() {
			return { set_focus: (value) => popover_calls.push(`focus:${value}`) }
		}
	}
	class Revealer {
		revealed = false
		handlers: (() => void)[] = []
		constructor() {
			revealers.push(this)
		}
		set_focusable() {}
		set_child(child) {
			revealer_child = child
		}
		connect(_signal: string, handler: () => void) {
			this.handlers.push(handler)
			return this.handlers.length
		}
		disconnect(id: number) {
			popover_calls.push(id === 1 ? "dispose" : `revealer-disconnect:${id}`)
		}
		get_child_revealed() {
			return this.revealed
		}
		get_reveal_child() {
			return this.revealed
		}
		reveal(value: boolean) {
			this.revealed = value
			for (const handler of this.handlers.slice(1)) handler()
		}
	}
	const gtk = {
		Gdk: { BUTTON_SECONDARY: 3 },
		Gtk: {
			Popover,
			Revealer,
			PositionType: { BOTTOM: 1, TOP: 2 },
			RevealerTransitionType: { SLIDE_DOWN: 0 },
			Orientation: { VERTICAL: 1 },
			GestureClick: "gesture",
			EventControllerMotion: "motion",
		},
	}
	const options = {
		default: {
			bar: { position: bar_position },
			colorpicker: { maxColors: max_colors },
			transition: { duration: create_state(200)[0] },
		},
	}
	const popover_module = await load_module(
		"widget/shared/animated_popover.ts",
		{
			"ags/gtk4": gtk,
			"ags/gobject": { default: { registerClass: (type) => type } },
			"$shell/options": options,
		},
	)
	const imports = {
		ags: {
			createState: (initial) => {
				const [get, set] = create_state(initial)
				colors = get
				return [get, set]
			},
			For: (props) => make("for", props),
			onCleanup: (fn) => cleanups.push(fn),
		},
		"ags/file": {
			readFile: (path) => {
				reads.push(path)
				return raw ?? JSON.stringify(history)
			},
			writeFileAsync: async (_path, data) => {
				await write(data)
				writes.push(JSON.parse(data))
			},
		},
		"ags/gtk4": gtk,
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"ags/process": { execAsync: () => picked() },
		"gi://Gio": {
			default: {
				File: {
					new_for_path: () => ({
						query_exists: () => history_exists,
					}),
				},
			},
		},
		"$lib/env": { default: { paths: { cache: { base: "/cache" } } } },
		"$lib/files": {
			ensure_file: () => ensure(),
			file_size: () => ({ ok: true, value: history_size }),
		},
		"$lib/clipboard": {
			copy_to_clipboard: (content: unknown) =>
				new Promise((resolve) =>
					copies.push({
						content,
						finish: (copied = true) =>
							resolve(
								copied
									? { ok: true, value: undefined }
									: { ok: false, err: new Error("wl-copy failed") },
							),
					}),
				),
		},
		"$lib/icons": { default: { ui: { colorpicker: "colorpicker" } } },
		"$lib/time": {
			idle: (fn) => {
				idles.push(fn)
				return { cancel: () => idles.splice(idles.indexOf(fn), 1) }
			},
			debounce: (_delay, fn) => ({
				call: () => {
					void fn()
				},
			}),
		},
		"$lib/notifications": {
			notify: async (value) => {
				notifications.push(value)
				return notify_result(notifications.length)
			},
			notify_missing_programs: (...bins: string[]) => {
				missing_checks.push(bins)
				return missing()
			},
		},
		"../PanelButton": { PanelButton: (props) => make("panel-button", props) },
		"widget/shared/animated_popover": popover_module,
		"$shell/options": options,
	}
	const module = await load_module(
		"widget/Bar/components/Buttons/ColorPicker.tsx",
		imports,
	)
	const button = module.ColorPicker()
	const gesture = nodes(button, "gesture")[0]
	return {
		button,
		colors,
		copies,
		notifications,
		writes,
		reads,
		errors,
		warnings,
		missing_checks,
		positions,
		idles,
		cleanups,
		popover_calls,
		popover: () => popovers[0],
		revealer: () => revealers[0],
		swatch_box: () => revealer_child,
		set_max,
		set_position,
		click: () => button.props.onClicked(),
		right_click: () => gesture.props.onReleased(),
		swatch: (color: string) =>
			nodes(revealer_child, "for")[0].props.children(color),
	}
}

test.afterEach(() => mock.restoreAll())

test("history with 80 colors remains intact with maxColors 100 and grows on a new pick", async () => {
	const history = Array.from(
		{ length: 80 },
		(_value, i) => `#${i.toString(16).padStart(6, "0")}`,
	)
	const fixture = await color_picker_fixture({ history })
	assert.deepEqual([...fixture.colors.peek()], history)
	assert.equal(fixture.writes.length, 0)
	fixture.click()
	await tick()
	assert.deepEqual(fixture.missing_checks, [["wl-copy", "hyprpicker"]])
	assert.equal(fixture.copies.length, 1)
	assert.equal(fixture.copies[0].content, "#abcdef")
	assert.equal(fixture.notifications.length, 0)
	fixture.copies[0].finish()
	await tick()
	assert.equal(fixture.colors.peek().length, 81)
	assert.deepEqual([...fixture.colors.peek()].slice(0, 80), history)
	assert.equal(fixture.colors.peek()[80], "#abcdef")
	assert.equal(fixture.writes[0].length, 81)
	assert.equal(fixture.notifications.length, 1)
	assert.deepEqual(fixture.notifications[0], {
		id: 0,
		app_name: "Colorpicker",
		app_icon: "colorpicker",
		summary: "Copied to clipboard",
		body: "#abcdef",
	})
})

test("failed clipboard copy logs and does not save or notify", async () => {
	const fixture = await color_picker_fixture()
	fixture.click()
	await tick()
	fixture.copies[0].finish(false)
	await tick()
	assert.deepEqual([...fixture.colors.peek()], [])
	assert.equal(fixture.writes.length, 0)
	assert.equal(fixture.notifications.length, 0)
	assert.equal(fixture.errors.length, 1)
	assert.equal(fixture.errors[0][0], "colorpicker.copy: Failed to copy color")
	assert.equal((fixture.errors[0][1] as Error).message, "wl-copy failed")
})

test("oversized history is rejected and starts empty", async () => {
	const fixture = await color_picker_fixture({
		history: ["#abcdef"],
		history_size: 64_001,
	})
	assert.deepEqual([...fixture.colors.peek()], [])
	assert.equal(fixture.errors.length, 1)
	assert.equal(
		fixture.errors[0][0],
		"colorpicker.load: Failed to load saved colors",
	)
	assert.equal(
		(fixture.errors[0][1] as Error).message,
		"Color history exceeds 64 KB",
	)
	assert.deepEqual(fixture.reads, [])
})

test("history at the 64 KB limit still loads", async () => {
	const fixture = await color_picker_fixture({
		history: ["#abcdef"],
		history_size: 64_000,
	})
	assert.deepEqual([...fixture.colors.peek()], ["#abcdef"])
	assert.equal(fixture.errors.length, 0)
})

test("history keeps only valid hex colors, newest within the limit", async () => {
	const valid = await color_picker_fixture({
		history: [
			"#000000",
			"#111111",
			"#333333",
			"#zzzzzz",
			7,
			"#22222",
			"#AbCdEf",
		],
		max: 3,
	})
	assert.deepEqual([...valid.colors.peek()], ["#111111", "#333333", "#AbCdEf"])
	const not_array = await color_picker_fixture({ history: { a: 1 } })
	assert.deepEqual([...not_array.colors.peek()], [])
	const missing = await color_picker_fixture({
		history: ["#111111"],
		history_exists: false,
	})
	assert.deepEqual([...missing.colors.peek()], [])
	assert.deepEqual(missing.reads, [])
	const unlimited = await color_picker_fixture({
		history: ["#111111"],
		max: 0,
	})
	assert.deepEqual([...unlimited.colors.peek()], [])
	assert.equal(unlimited.errors.length, 0)
})

test("unparseable history logs and starts empty", async () => {
	const fixture = await color_picker_fixture({ raw: "[broken" })
	assert.deepEqual([...fixture.colors.peek()], [])
	assert.equal(fixture.errors.length, 1)
	assert.equal(
		fixture.errors[0][0],
		"colorpicker.load: Failed to load saved colors",
	)
})

test("a re-picked color moves to the end and the oldest falls off the limit", async () => {
	const fixture = await color_picker_fixture({
		history: ["#abcdef", "#111111", "#222222"],
		max: 3,
		picked: async () => "#abcdef",
	})
	fixture.click()
	await tick()
	fixture.copies[0].finish()
	await tick()
	assert.deepEqual(
		[...fixture.colors.peek()],
		["#111111", "#222222", "#abcdef"],
	)
	const trimmed = await color_picker_fixture({
		history: ["#111111", "#222222"],
		max: 2,
		picked: async () => "#333333",
	})
	trimmed.click()
	await tick()
	trimmed.copies[0].finish()
	await tick()
	assert.deepEqual([...trimmed.colors.peek()], ["#222222", "#333333"])
	assert.deepEqual(trimmed.writes, [["#222222", "#333333"]])
})

test("picker output is cleaned and invalid or failed picks stop silently", async () => {
	const noisy = await color_picker_fixture({
		picked: async () => "[ERR] renderSurface: PBUFFER null\n#123456\n",
	})
	noisy.click()
	await tick()
	assert.equal(noisy.copies[0].content, "#123456")

	const invalid = await color_picker_fixture({ picked: async () => "nope" })
	invalid.click()
	await tick()
	assert.equal(invalid.copies.length, 0)

	const failed = await color_picker_fixture({
		picked: async () => {
			throw new Error("cancelled")
		},
	})
	failed.click()
	await tick()
	assert.equal(failed.copies.length, 0)
	assert.equal(failed.errors.length, 0)

	const missing = await color_picker_fixture({ missing: () => false })
	missing.click()
	await tick()
	assert.equal(missing.copies.length, 0)
	assert.deepEqual(missing.missing_checks, [["wl-copy", "hyprpicker"]])
})

test("clicking a saved swatch copies it without picking or saving", async () => {
	const fixture = await color_picker_fixture({
		history: ["#111111", "#222222"],
		picked: async () => {
			throw new Error("picker must not run")
		},
	})
	fixture.swatch("#111111").props.onClicked()
	assert.deepEqual(fixture.popover_calls.slice(-2), ["focus:null", "popdown"])
	await tick()
	assert.deepEqual(fixture.missing_checks, [["wl-copy"]])
	assert.equal(fixture.copies[0].content, "#111111")
	fixture.copies[0].finish()
	await tick()
	assert.deepEqual([...fixture.colors.peek()], ["#111111", "#222222"])
	assert.equal(fixture.writes.length, 0)
	assert.equal(fixture.notifications[0].body, "#111111")

	const missing = await color_picker_fixture({
		history: ["#111111"],
		missing: () => false,
	})
	missing.swatch("#111111").props.onClicked()
	await tick()
	assert.equal(missing.copies.length, 0)
})

test("picks run one at a time and more than eight pending picks are refused", async () => {
	const fixture = await color_picker_fixture()
	for (let i = 0; i < 9; i++) fixture.click()
	await tick()
	assert.equal(fixture.copies.length, 1)
	assert.deepEqual(fixture.warnings, [
		["colorpicker.pick: Too many pending requests"],
	])
	fixture.copies[0].finish()
	await tick()
	assert.equal(fixture.copies.length, 2)
	fixture.click()
	await tick()
	assert.equal(fixture.warnings.length, 1)
})

test("a pick that throws is logged and the queue keeps going", async () => {
	let calls = 0
	const fixture = await color_picker_fixture({
		missing: () => {
			calls++
			if (calls === 1) throw new Error("lookup failed")
			return true
		},
	})
	fixture.click()
	fixture.click()
	await tick()
	assert.equal(fixture.errors.length, 1)
	assert.equal(fixture.errors[0][0], "colorpicker.pick: Failed to pick color")
	assert.equal((fixture.errors[0][1] as Error).message, "lookup failed")
	assert.equal(fixture.copies.length, 1)
})

test("notification id is reused and a failed notification is logged", async () => {
	const fixture = await color_picker_fixture({
		notify_result: (count) =>
			count === 1
				? { ok: true, value: 41 }
				: { ok: false, err: new Error("bus down") },
	})
	fixture.click()
	await tick()
	fixture.copies[0].finish()
	await tick()
	fixture.click()
	await tick()
	fixture.copies[1].finish()
	await tick()
	assert.deepEqual(
		fixture.notifications.map((value) => value.id),
		[0, 41],
	)
	assert.equal(fixture.errors.length, 1)
	assert.equal(
		fixture.errors[0][0],
		"colorpicker.notify: Failed to announce copied color",
	)
	fixture.click()
	await tick()
	fixture.copies[2].finish()
	await tick()
	assert.equal(fixture.notifications[2].id, 41)
})

test("failed saves are logged and not retried until colors change again", async () => {
	let fail = true
	const fixture = await color_picker_fixture({
		write: async () => {
			if (fail) throw new Error("disk full")
		},
	})
	fixture.click()
	await tick()
	fixture.copies[0].finish()
	await tick()
	assert.equal(fixture.writes.length, 0)
	assert.equal(fixture.errors.length, 1)
	assert.equal(fixture.errors[0][0], "colorpicker.save: Failed to save colors")
	fail = false
	await tick()
	assert.equal(fixture.writes.length, 0)
	fixture.click()
	await tick()
	fixture.copies[1].finish()
	await tick()
	assert.deepEqual(fixture.writes, [["#abcdef"]])
})

test("lowering maxColors trims and saves history, raising it does nothing", async () => {
	const fixture = await color_picker_fixture({
		history: ["#111111", "#222222", "#333333"],
	})
	fixture.set_max(5)
	await tick()
	assert.equal(fixture.writes.length, 0)
	fixture.set_max(2)
	await tick()
	assert.deepEqual([...fixture.colors.peek()], ["#222222", "#333333"])
	assert.deepEqual(fixture.writes, [["#222222", "#333333"]])
	fixture.set_max(0)
	await tick()
	assert.deepEqual([...fixture.colors.peek()], [])
	assert.deepEqual(fixture.writes.at(-1), [])
})

test("popover follows the bar position and right click opens history on idle", async () => {
	const fixture = await color_picker_fixture({ position: "bottom-center" })
	assert.equal(fixture.positions.at(-1), 2)
	fixture.set_position("top-center")
	assert.equal(fixture.positions.at(-1), 1)
	fixture.right_click()
	assert.equal(fixture.idles.length, 0)

	const filled = await color_picker_fixture({ history: ["#111111"] })
	assert.equal(filled.positions.at(-1), 1)
	filled.right_click()
	filled.right_click()
	assert.equal(filled.idles.length, 1)
	filled.idles[0]()
	assert.equal(filled.popover_calls.at(-1), "popup")
	assert.equal(filled.button.props.tooltipText(), "1 color")
})

test("cleanup unsubscribes, cancels the pending popup and unparents", async () => {
	const fixture = await color_picker_fixture({ history: ["#111111"] })
	fixture.right_click()
	for (const cleanup of fixture.cleanups) cleanup()
	assert.equal(fixture.idles.length, 0)
	assert.ok(fixture.popover_calls.includes("dispose"))
	assert.equal(fixture.popover_calls.at(-1), "unparent")
	const before = fixture.positions.length
	fixture.set_position("bottom-center")
	fixture.set_max(0)
	assert.equal(fixture.positions.length, before)
	assert.deepEqual([...fixture.colors.peek()], ["#111111"])
})

test("a save that cannot create the history file is logged without writing", async () => {
	const fixture = await color_picker_fixture({
		ensure: () => ({ ok: false, err: new Error("read-only cache") }),
	})
	fixture.click()
	await tick()
	fixture.copies[0].finish()
	await tick()
	assert.equal(fixture.writes.length, 0)
	assert.equal(fixture.errors.length, 1)
	assert.equal(fixture.errors[0][0], "colorpicker.save: Failed to save colors")
	assert.equal((fixture.errors[0][1] as Error).message, "read-only cache")
})

function held_writes(fail_first = false) {
	const pending: (() => void)[] = []
	let active = 0
	let most = 0
	let count = 0
	return {
		pending,
		most: () => most,
		write: () =>
			new Promise<void>((resolve, reject) => {
				count++
				const failing = fail_first && count === 1
				active++
				most = Math.max(most, active)
				pending.push(() => {
					active--
					if (failing) reject(new Error("disk full"))
					else resolve()
				})
			}),
	}
}

test("saves run one at a time and changes made during a save are written afterwards", async () => {
	const held = held_writes()
	const fixture = await color_picker_fixture({
		history: ["#111111", "#222222", "#333333"],
		write: held.write,
	})
	fixture.set_max(2)
	await tick()
	fixture.set_max(1)
	await tick()
	assert.equal(held.pending.length, 1)
	held.pending[0]()
	await tick()
	assert.equal(held.pending.length, 2)
	held.pending[1]()
	await tick()
	assert.equal(held.most(), 1)
	assert.deepEqual(fixture.writes, [["#222222", "#333333"], ["#333333"]])
})

test("a change made during a failed save is saved again", async () => {
	const held = held_writes(true)
	const fixture = await color_picker_fixture({
		history: ["#111111", "#222222", "#333333"],
		write: held.write,
	})
	fixture.set_max(2)
	await tick()
	fixture.set_max(1)
	await tick()
	held.pending[0]()
	await tick()
	assert.equal(fixture.errors[0][0], "colorpicker.save: Failed to save colors")
	assert.equal(held.pending.length, 2)
	held.pending[1]()
	await tick()
	assert.deepEqual(fixture.writes, [["#333333"]])
})

test("a swatch shows its hex only after the popover settles and the pointer really moves, and hides it on close", async () => {
	const f = await color_picker_fixture({ history: ["#111111", "#222222"] })
	const classes = (name: string) => {
		const set = new Set<string>()
		return {
			name,
			set,
			add_css_class: (value: string) => set.add(value),
			remove_css_class: (value: string) => set.delete(value),
		}
	}
	const first = classes("first")
	const second = classes("second")
	const linked = (widget, next) => ({ ...widget, get_next_sibling: () => next })
	const first_node = linked(first, linked(second, null))
	f.swatch_box().props.$({ get_first_child: () => first_node })
	const motion = nodes(f.swatch("#111111"), "motion")[0].props
	const widget = { get_widget: () => first }

	motion.onMotion(widget, 5, 5)
	assert.deepEqual([...first.set], [])

	f.revealer().reveal(true)
	motion.onMotion(widget, 5, 6)
	assert.deepEqual([...first.set], ["hovered"])
	motion.onLeave(widget)
	assert.deepEqual([...first.set], [])

	motion.onMotion(widget, 5, 7)
	second.add_css_class("hovered")
	f.popover().emit("closed")
	assert.deepEqual([...first.set], [])
	assert.deepEqual([...second.set], [])
	motion.onMotion(widget, 5, 8)
	assert.deepEqual([...first.set], [])

	f.revealer().reveal(true)
	motion.onEnter(widget, 5, 8)
	motion.onMotion(widget, 5, 8)
	assert.deepEqual([...first.set], [])
	motion.onMotion(widget, 6, 8)
	assert.deepEqual([...first.set], ["hovered"])
	f.revealer().reveal(false)
	assert.deepEqual([...first.set], [])

	for (const cleanup of f.cleanups) cleanup()
	assert.ok(f.popover_calls.includes("disconnect:7"))
	assert.ok(f.popover_calls.includes("revealer-disconnect:2"))
	assert.ok(f.popover_calls.includes("revealer-disconnect:3"))
})
