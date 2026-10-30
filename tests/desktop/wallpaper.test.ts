import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { load_module } from "../load_module.ts"
import { create_state, queued_idle } from "../helpers.ts"

type decode_mode = "static" | "animated" | "throws" | "empty" | "broken_frames"

async function wallpaper_fixture({
	decode = "static" as decode_mode,
	fallback = true,
} = {}) {
	const log: string[] = []
	const errors: unknown[][] = []
	const sources = new Map<number, () => unknown>()
	const delays: number[] = []
	const idles: (() => void)[] = []
	const cleanups: (() => void)[] = []
	const stacks: any[] = []
	const [revision, set_revision, revision_listeners] = create_state(1)
	let next_source = 0
	let frame = 0
	let decodes = 0
	const sizes: string[] = []
	const image = { width: 5120, height: 2880 }
	mock.method(console, "error", (...args) => errors.push(args))
	class Picture {
		paintable: unknown = "unset"
		set_paintable(value) {
			this.paintable = value
		}
	}
	class Stack {
		children = new Map<string, Picture>()
		visible = ""
		durations: number[] = []
		transition_running = false
		handlers = new Map<number, () => void>()
		connect(_signal, handler) {
			this.handlers.set(this.handlers.size + 1, handler)
			return this.handlers.size
		}
		disconnect(id) {
			this.handlers.delete(id)
		}
		finish_transition() {
			this.transition_running = false
			for (const handler of this.handlers.values()) handler()
		}
		add_named(child, name) {
			this.children.set(name, child)
		}
		set_transition_type() {}
		set_transition_duration(value) {
			this.durations.push(value)
		}
		set_visible_child_name(name) {
			this.visible = `${name}@${this.durations.at(-1)}`
			this.transition_running = this.durations.at(-1)! > 0
		}
	}
	const iter = {
		get_delay_time: () => 4,
		get_pixbuf: () => `frame${frame}`,
		advance: () => {
			frame++
			return true
		},
	}
	let size = ""
	const animation = {
		is_static_image: () => decode !== "animated" && decode !== "broken_frames",
		get_static_image: () => (decode === "empty" ? null : `still${size}`),
		get_iter: () => {
			if (decode === "broken_frames") throw new Error("bad frame")
			return iter
		},
	}
	const window = {
		mapped: true,
		properties: [] as unknown[],
		get_mapped() {
			return this.mapped
		},
		set_property(name, value) {
			this.properties.push([name, value])
		},
	}
	const make = (type, props: Record<string, any> = {}) => {
		if (type === "window") return window
		if (type === Stack) {
			const stack = new Stack()
			stacks.push(stack)
			props.$(stack)
			return stack
		}
		return { type, props }
	}
	const module = await load_module("widget/Wallpaper/index.tsx", {
		ags: { onCleanup: (fn) => cleanups.push(fn) },
		"ags/gtk4": {
			Astal: {
				Layer: { BACKGROUND: 0 },
				Exclusivity: { IGNORE: 2 },
				Keymode: { NONE: 0 },
				WindowAnchor: { TOP: 1, BOTTOM: 2, LEFT: 4, RIGHT: 8 },
			},
			Gdk: {
				Texture: {
					new_for_pixbuf: (pixbuf) => `texture:${pixbuf}`,
					new_from_filename: (path) => {
						if (!fallback) throw new Error("unsupported format")
						return `file:${path}`
					},
				},
			},
			Gtk: {
				Picture,
				Stack,
				ContentFit: { COVER: 2 },
				StackTransitionType: { CROSSFADE: 1 },
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"$lib/time": {
			idle: queued_idle(idles),
		},
		"gi://GdkPixbuf": {
			default: {
				PixbufLoader: class {
					prepared: (loader, width, height) => void = () => {}
					connect(_signal, handler) {
						this.prepared = handler
					}
					set_size(width, height) {
						size = `@${width}x${height}`
					}
					write_bytes() {
						size = ""
						this.prepared(this, image.width, image.height)
					}
					close() {
						decodes++
						sizes.push(size)
						if (decode === "throws") throw new Error("not an image")
					}
					get_animation() {
						return animation
					}
				},
			},
		},
		"gi://Gio": {
			default: {
				File: {
					new_for_path: () => ({
						read: () => {
							let chunks = 1
							return {
								read_bytes: () => ({ get_size: () => chunks-- }),
								close: () => log.push("closed"),
							}
						},
					}),
				},
			},
		},
		"gi://GLib": {
			default: {
				PRIORITY_DEFAULT: 0,
				SOURCE_REMOVE: false,
				timeout_add: (_priority, delay, fn) => {
					next_source++
					delays.push(delay)
					sources.set(next_source, fn)
					return next_source
				},
				source_remove: (id) => {
					log.push(`remove:${id}`)
					sources.delete(id)
				},
			},
		},
		"gi://Gtk4LayerShell": {
			default: {
				Edge: { LEFT: 0 },
				set_margin: (_window, _edge, value) => log.push(`margin:${value}`),
			},
		},
		"$lib/windowing": {
			ignore_input: () => {},
			schedule_monitor_window_release: () => log.push("release"),
		},
		"$lib/wallpaper": {
			wallpaper_path: "/wall.gif",
			wallpaper_revision: revision,
		},
	})
	function monitor(width = 1920, height = 1200, scale = 1) {
		const handlers = new Map<number, () => void>()
		return {
			width,
			height,
			scale,
			handlers,
			get_geometry() {
				return { x: 0, y: 0, width: this.width, height: this.height }
			},
			get_scale() {
				return this.scale
			},
			connect(_signal, handler) {
				handlers.set(handlers.size + 1, handler)
				return handlers.size
			},
			disconnect(id) {
				handlers.delete(id)
			},
			resize(next_width, next_height) {
				this.width = next_width
				this.height = next_height
				for (const handler of [...handlers.values()]) handler()
			},
		}
	}
	return {
		module,
		log,
		errors,
		sources,
		delays,
		idles,
		cleanups,
		stacks,
		bump_revision: () => set_revision((value) => value + 1),
		revision_listeners,
		window,
		decodes: () => decodes,
		sizes,
		image,
		tick() {
			for (const [id, fn] of [...sources]) {
				sources.delete(id)
				fn()
			}
		},
		monitor,
		open: (gdkmonitor = monitor()) => module.Wallpaper.Window({ gdkmonitor }),
	}
}

test.afterEach(() => mock.restoreAll())

test("a static wallpaper is decoded once and shared by every monitor", async () => {
	const f = await wallpaper_fixture()
	f.open()
	f.open()
	const [first, second] = f.stacks
	assert.equal(first.children.get("b").paintable, "texture:still@2134x1200")
	assert.equal(second.children.get("b").paintable, "texture:still@2134x1200")
	assert.equal(first.children.get("a").paintable, "unset")
	assert.equal(first.visible, "b@0")
	assert.deepEqual(first.durations, [0, 600])
	assert.equal(f.decodes(), 1)
})

test("a wallpaper the animation decoder rejects falls back to a texture", async () => {
	const f = await wallpaper_fixture({ decode: "throws" })
	f.open()
	assert.equal(f.stacks[0].children.get("b").paintable, "file:/wall.gif")
	const empty = await wallpaper_fixture({ decode: "empty" })
	empty.open()
	assert.equal(empty.stacks[0].children.get("b").paintable, "file:/wall.gif")
	const broken = await wallpaper_fixture({ decode: "broken_frames" })
	broken.open()
	assert.equal(broken.stacks[0].children.get("b").paintable, "file:/wall.gif")
	assert.equal(f.errors.length + empty.errors.length + broken.errors.length, 0)
})

test("a wallpaper no decoder can read is logged with both causes", async () => {
	const f = await wallpaper_fixture({ decode: "throws", fallback: false })
	f.open()
	assert.equal(f.stacks[0].children.get("b").paintable, null)
	assert.equal(f.errors.length, 1)
	const [tag, error] = f.errors[0] as [string, Error]
	assert.equal(tag, "wallpaper.paint: Failed to render /wall.gif")
	assert.equal(error.message, "All wallpaper decoders failed")
	const cause = error.cause as { animated: Error; static: Error }
	assert.equal(cause.animated.message, "not an image")
	assert.equal(cause.static.message, "unsupported format")
	f.open()
	assert.equal(f.decodes(), 2)

	const empty = await wallpaper_fixture({ decode: "empty", fallback: false })
	empty.open()
	const empty_cause = (empty.errors[0][1] as Error).cause as {
		animated: Error
	}
	assert.equal(
		empty_cause.animated.message,
		"Wallpaper decoder returned no image",
	)
})

test("an animated wallpaper plays one shared timer until its last picture stops", async () => {
	const f = await wallpaper_fixture({ decode: "animated" })
	f.open()
	f.open()
	const pictures = f.stacks.map((stack) => stack.children.get("b"))
	assert.deepEqual(
		pictures.map((picture) => picture.paintable),
		["texture:frame0", "texture:frame0"],
	)
	assert.equal(f.decodes(), 1)
	assert.deepEqual(f.delays, [10])
	f.tick()
	assert.deepEqual(
		pictures.map((picture) => picture.paintable),
		["texture:frame1", "texture:frame1"],
	)
	assert.equal(f.sources.size, 1)
	f.cleanups[0]()
	assert.equal(f.sources.size, 1)
	f.cleanups[2]()
	assert.equal(f.sources.size, 0)
	assert.equal(f.log.filter((entry) => entry.startsWith("remove")).length, 1)
	f.open()
	assert.equal(f.decodes(), 2)
})

test("a timer that fires after every picture left stops itself", async () => {
	const f = await wallpaper_fixture({ decode: "animated" })
	f.open()
	const [, fire] = [...f.sources][0]
	f.cleanups[0]()
	assert.equal(fire(), false)
	assert.equal(f.sources.size, 0)
})

test("a new revision paints the other slot and crossfades on idle", async () => {
	const f = await wallpaper_fixture()
	f.open()
	const stack = f.stacks[0]
	f.bump_revision()
	assert.equal(stack.children.get("a").paintable, "texture:still@2134x1200")
	assert.equal(stack.visible, "b@0")
	f.bump_revision()
	assert.equal(f.idles.length, 1)
	f.idles.shift()!()
	assert.equal(stack.visible, "a@600")
	f.bump_revision()
	assert.equal(stack.children.get("b").paintable, "texture:still@2134x1200")
	f.idles.shift()!()
	assert.equal(stack.visible, "b@600")
	assert.equal(f.decodes(), 4)
})

test("cleanup stops the stack and releases the window", async () => {
	const f = await wallpaper_fixture({ decode: "animated" })
	f.open()
	f.bump_revision()
	for (const cleanup of f.cleanups) cleanup()
	assert.equal(f.idles.length, 0)
	assert.equal(f.revision_listeners.size, 0)
	assert.equal(f.sources.size, 0)
	assert.ok(f.log.includes("release"))
})

test("retarget moves the window and rearrange nudges a mapped layer", async () => {
	const f = await wallpaper_fixture()
	const handle = f.open()
	const hdmi = f.monitor()
	handle.retarget(hdmi)
	assert.deepEqual(f.window.properties, [["gdkmonitor", hdmi]])
	f.log.length = 0
	handle.rearrange()
	assert.deepEqual(f.log, ["margin:1", "margin:0"])
	f.window.mapped = false
	handle.rearrange()
	assert.equal(f.log.length, 2)
})

test("the wallpaper is decoded just large enough to cover its monitor", async () => {
	const f = await wallpaper_fixture()
	f.open(f.monitor(1920, 1200, 2))
	f.open(f.monitor(1920, 1080))
	f.open(f.monitor(0, 0))
	assert.deepEqual(f.sizes, ["@4267x2400", "@1920x1080", ""])
	f.image.width = 1280
	f.image.height = 720
	f.open(f.monitor(1920, 1200))
	assert.equal(f.sizes.at(-1), "")
	assert.equal(f.stacks.at(-1).children.get("b").paintable, "texture:still")
})

test("a monitor that grows or moves to a larger output re-decodes in place", async () => {
	const f = await wallpaper_fixture()
	const laptop = f.monitor()
	const handle = f.open(laptop)
	const stack = f.stacks[0]
	laptop.resize(1920, 1200)
	assert.equal(f.decodes(), 1)
	laptop.resize(2560, 1600)
	assert.equal(stack.children.get("b").paintable, "texture:still@2845x1600")
	assert.equal(stack.visible, "b@0")
	const external = f.monitor(3840, 2160)
	handle.retarget(external)
	assert.equal(laptop.handlers.size, 0)
	assert.equal(external.handlers.size, 2)
	assert.equal(stack.children.get("b").paintable, "texture:still@3840x2160")
	assert.equal(f.decodes(), 3)
	f.cleanups[1]()
	assert.equal(external.handlers.size, 0)
})

test("a monitor reporting no size yet keeps its decode until the real size arrives", async () => {
	const f = await wallpaper_fixture()
	const laptop = f.monitor()
	f.open(laptop)
	const stack = f.stacks[0]
	laptop.resize(0, 0)
	assert.equal(f.decodes(), 1)
	assert.equal(stack.children.get("b").paintable, "texture:still@2134x1200")
	laptop.resize(2560, 1600)
	assert.equal(f.decodes(), 2)
	assert.equal(stack.children.get("b").paintable, "texture:still@2845x1600")
})

test("the faded-out picture lets go of its texture once the crossfade ends", async () => {
	const f = await wallpaper_fixture()
	f.open()
	const stack = f.stacks[0]
	f.bump_revision()
	f.idles.shift()!()
	assert.equal(stack.children.get("b").paintable, "texture:still@2134x1200")
	stack.finish_transition()
	assert.equal(stack.children.get("b").paintable, null)
	assert.equal(stack.children.get("a").paintable, "texture:still@2134x1200")
	f.bump_revision()
	f.idles.shift()!()
	f.bump_revision()
	stack.finish_transition()
	assert.equal(stack.children.get("a").paintable, "texture:still@2134x1200")
	f.idles.shift()!()
	stack.finish_transition()
	assert.equal(stack.children.get("b").paintable, null)
	f.cleanups[0]()
	assert.equal(stack.handlers.size, 0)
})
