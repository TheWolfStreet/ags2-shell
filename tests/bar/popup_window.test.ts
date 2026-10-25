import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { accessor, create_state, nodes } from "../helpers.ts"

function fake_revealer(log: string[], mapped = true) {
	const child = { set_opacity: (value) => log.push(`child:${value}`) }
	let reveal = false
	let revealed = false
	return {
		set_opacity: (value) => log.push(`opacity:${value}`),
		get_child: () => child,
		set_reveal_child: (value) => {
			reveal = value
			log.push(`reveal:${value}`)
		},
		get_reveal_child: () => reveal,
		get_child_revealed: () => revealed,
		set_child_revealed: (value) => {
			revealed = value
		},
		get_mapped: () => mapped,
		compute_bounds: () => [
			true,
			{
				contains_point: ({ x, y }) => x >= 10 && x <= 20 && y >= 10 && y <= 20,
			},
		],
	}
}

const ui = await load_module("lib/ui.ts", {
	ags: {},
	"ags/gtk4": { Gtk: {} },
	"gi://Pango": { default: {} },
})

async function popup_fixture() {
	const log: string[] = []
	const cleanups: (() => void)[] = []
	const mounts: (() => void)[] = []
	class Window {
		visible = false
		props: Record<string, any> = {}
		show() {
			log.push("show")
			if (!this.visible) this.vfunc_show()
		}
		hide() {
			log.push("hide")
			if (this.visible) this.vfunc_hide()
		}
		vfunc_show() {
			this.visible = true
			log.push("super.show")
		}
		vfunc_hide() {
			this.visible = false
			log.push("super.hide")
		}
		get_visible() {
			return this.visible
		}
		notify(name: string) {
			log.push(`notify:${name}`)
		}
	}
	const make = (type, props: Record<string, any> = {}) => {
		if (type.prototype instanceof Window) {
			const window = new type()
			window.props = props
			window.visible = props.visible
			props.$(window)
			return window
		}
		if (typeof type === "function") return type(props)
		return { type, props }
	}
	const [bar_position, set_bar_position] = create_state("top-center")
	const module = await load_module("widget/shared/PopupWindow.tsx", {
		ags: {
			createComputed: (fn) => accessor(fn),
			createState: create_state,
			onCleanup: (fn) => cleanups.push(fn),
			onMount: (fn) => mounts.push(fn),
		},
		"ags/gtk4": {
			Astal: {
				Window,
				WindowAnchor: { TOP: 1, BOTTOM: 2, LEFT: 4, RIGHT: 8 },
				Keymode: { ON_DEMAND: 2 },
				Exclusivity: { IGNORE: 2 },
				Layer: { TOP: 2, OVERLAY: 3 },
			},
			Gdk: { KEY_Escape: 27 },
			Gtk: {
				Align: { START: 1, END: 2, CENTER: 3 },
				RevealerTransitionType: {
					SLIDE_UP: 4,
					SLIDE_DOWN: 5,
					SLIDE_LEFT: 6,
					SLIDE_RIGHT: 7,
					CROSSFADE: 8,
				},
				EventControllerKey: "key",
				GestureClick: "click",
				Revealer: "revealer",
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"ags/gobject": { default: { registerClass: (type) => type } },
		"gi://Graphene": {
			default: {
				Point: class {
					x: number
					y: number
					constructor({ x, y }) {
						this.x = x
						this.y = y
					}
				},
			},
		},
		"$lib/ui": ui,
		"$shell/options": {
			default: {
				transition: { duration: accessor(() => 200) },
				bar: { position: bar_position },
			},
		},
	})
	function render(props: Record<string, any> = {}) {
		const window = module.PopupWindow({ children: "content", ...props })
		const revealer_node = nodes(window.props.children, "revealer")[0]
		return {
			window,
			props: window.props,
			key: nodes(window.props.children, "key")[0].props,
			click: nodes(window.props.children, "click")[0].props,
			revealer_node,
			mount(revealer = fake_revealer(log)) {
				revealer_node.props.$(revealer)
				for (const fn of mounts.splice(0)) fn()
				return revealer
			},
		}
	}
	return { module, render, log, cleanups, set_bar_position }
}

test("window classes, defaults and alignment follow name, class and layout", async () => {
	const f = await popup_fixture()
	const plain = f.render()
	assert.equal(plain.props.name, "popup")
	assert.equal(plain.props.class(), "popup-window popup")
	assert.equal(plain.props.visible, false)
	assert.equal(plain.props.keymode, 2)
	assert.equal(plain.props.anchor, 15)
	assert.equal(plain.props.exclusivity, 2)
	assert.equal(plain.props.layer, 2)
	assert.equal(plain.props.decorated, false)
	assert.equal(plain.revealer_node.props.transitionType(), 8)
	assert.equal(plain.revealer_node.props.halign(), 3)

	const named = f.render({
		name: accessor(() => "launcher"),
		class: accessor(() => "wide"),
		layout: "top-right",
	})
	assert.equal(named.props.class(), "popup-window launcher wide")
	assert.equal(named.revealer_node.props.halign(), 2)
	assert.equal(named.revealer_node.props.valign(), 1)
	assert.equal(named.revealer_node.props.transitionType(), 5)

	const empty = f.render({ name: "", class: "x", transitionType: 6 })
	assert.equal(empty.props.class(), "popup-window x")
	assert.equal(empty.revealer_node.props.transitionType, 6)

	const [layout, set_layout] = create_state("bottom-left")
	const live = f.render({ layout })
	assert.equal(live.revealer_node.props.valign(), 2)
	set_layout("center-left")
	assert.equal(live.revealer_node.props.valign(), 3)
	assert.equal(live.revealer_node.props.transitionType(), 7)
	set_layout("nonsense")
	assert.equal(live.revealer_node.props.transitionType(), 8)
})

test("an accessor visibility starts from its value and drives the requested state", async () => {
	const f = await popup_fixture()
	const [visible, set_visible, visible_listeners] = create_state(true)
	const popup = f.render({ visible })
	assert.equal(popup.props.visible, true)
	const revealer = popup.mount()
	assert.deepEqual(f.log, ["opacity:1", "child:1", "reveal:true"])
	f.log.length = 0
	set_visible(false)
	assert.equal(popup.window.requested_visible, false)
	assert.deepEqual(f.log, ["hide", "reveal:false"])
	f.log.length = 0
	set_visible(true)
	assert.equal(popup.window.requested_visible, true)
	assert.deepEqual(f.log, ["show", "opacity:1", "child:1", "reveal:true"])
	assert.equal(revealer.get_reveal_child(), true)
	for (const cleanup of f.cleanups) cleanup()
	assert.equal(visible_listeners.size, 0)
})

test("hiding waits for the revealer and finishes once it has collapsed", async () => {
	const f = await popup_fixture()
	const popup = f.render({ visible: true })
	const revealer = popup.mount()
	f.log.length = 0
	popup.window.hide()
	assert.deepEqual(f.log, ["hide", "reveal:false"])
	assert.equal(popup.window.visible, true)
	popup.revealer_node.props.onNotifyChildRevealed(revealer)
	assert.deepEqual(f.log.slice(2), ["super.hide", "notify:visible"])

	f.log.length = 0
	popup.window.visible = true
	popup.window.requested_visible = true
	popup.revealer_node.props.onNotifyChildRevealed(revealer)
	revealer.set_reveal_child(true)
	popup.window.requested_visible = false
	popup.revealer_node.props.onNotifyChildRevealed(revealer)
	revealer.set_reveal_child(false)
	revealer.set_child_revealed(true)
	popup.revealer_node.props.onNotifyChildRevealed(revealer)
	assert.deepEqual(f.log, ["reveal:true", "reveal:false"])
})

test("hiding an unmapped or missing revealer completes at once", async () => {
	const f = await popup_fixture()
	const bare = f.render({ visible: true })
	f.log.length = 0
	bare.window.hide()
	assert.deepEqual(f.log, ["hide", "super.hide", "notify:visible"])

	const unmapped = f.render({ visible: true })
	unmapped.mount(fake_revealer(f.log, false))
	f.log.length = 0
	unmapped.window.hide()
	assert.deepEqual(f.log, [
		"hide",
		"reveal:false",
		"super.hide",
		"notify:visible",
	])
})

test("a hidden window mounts without revealing and reveals when shown", async () => {
	const f = await popup_fixture()
	const popup = f.render()
	popup.mount()
	assert.deepEqual(f.log, [])
	popup.window.show()
	assert.equal(popup.window.requested_visible, true)
	assert.deepEqual(f.log, [
		"show",
		"super.show",
		"opacity:1",
		"child:1",
		"reveal:true",
	])
})

test("escape and outside clicks close only when closing is handled", async () => {
	const f = await popup_fixture()
	const keys: unknown[][] = []
	const popup = f.render({
		visible: true,
		onKey: (...args) => keys.push(args),
	})
	popup.mount()
	f.log.length = 0
	popup.click.onPressed(null, 1, 15, 15)
	assert.deepEqual(f.log, [])
	popup.click.onPressed(null, 1, 50, 15)
	assert.deepEqual(f.log, ["hide", "reveal:false"])
	popup.window.visible = true
	f.log.length = 0
	popup.key.onKeyPressed("controller", 27, 9, 0)
	assert.deepEqual(f.log, ["hide", "reveal:false"])
	assert.deepEqual(keys, [["controller", 27, 9, 0, popup.window]])
	popup.window.visible = true
	f.log.length = 0
	popup.key.onKeyPressed("controller", 65, 38, 0)
	assert.deepEqual(f.log, [])

	const unmounted = f.render({ visible: true })
	f.log.length = 0
	unmounted.click.onPressed(null, 1, 50, 50)
	assert.deepEqual(f.log, [])

	const kept = f.render({ visible: true, handle_closing: false })
	kept.mount()
	f.log.length = 0
	kept.click.onPressed(null, 1, 50, 50)
	kept.key.onKeyPressed("controller", 27, 9, 0)
	assert.deepEqual(f.log, [])
})

test("cleanup hides the window immediately", async () => {
	const f = await popup_fixture()
	const popup = f.render({ visible: true })
	popup.mount()
	f.log.length = 0
	for (const cleanup of f.cleanups) cleanup()
	assert.deepEqual(f.log, ["super.hide", "notify:visible"])
})

test("bar-attached popups sit on the bar edge above the dock and ignore other reserved zones", async () => {
	const f = await popup_fixture()
	const plain = f.render()
	assert.equal(plain.props.marginTop, undefined)
	assert.equal(plain.props.marginBottom, undefined)

	const attached = f.render({ attach_to_bar: true })
	assert.equal(attached.props.attach_to_bar, undefined)
	assert.equal(attached.props.exclusivity, 2)
	assert.equal(attached.props.layer, 3)
	f.module.set_bar_thickness(40)
	assert.equal(attached.props.marginTop(), 40)
	assert.equal(attached.props.marginBottom(), 0)

	f.set_bar_position("bottom-center")
	assert.equal(attached.props.marginTop(), 0)
	assert.equal(attached.props.marginBottom(), 40)
	f.module.set_bar_thickness(52)
	assert.equal(attached.props.marginBottom(), 52)
})
