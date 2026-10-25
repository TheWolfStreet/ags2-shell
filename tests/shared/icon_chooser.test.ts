import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { create_state, nodes } from "../helpers.ts"

class FakeWindow {
	props: Record<string, any>
	children: unknown[]
	presented = 0
	closed = 0
	constructor(props: Record<string, any>) {
		this.props = props
		this.children = [props.children].flat().filter(Boolean)
	}
	present() {
		this.presented++
	}
	close() {
		this.closed++
		this.props.onCloseRequest()
	}
}

function make(type, props: Record<string, any> = {}) {
	if (type === FakeWindow) return new FakeWindow(props)
	if (typeof type === "function") return type(props)
	return { type, props, children: [props.children].flat().filter(Boolean) }
}

async function fixture() {
	const windows: FakeWindow[] = []
	const pickers: Record<string, any>[] = []
	const idles: (() => void)[] = []
	const disposed: number[] = []
	const parent = new FakeWindow({})
	const { choose_icon } = await load_module("widget/shared/icon_chooser.tsx", {
		ags: {
			createState: create_state,
			createRoot: (fn) => fn(() => disposed.push(1)),
		},
		"ags/gtk4": {
			Gdk: { KEY_Escape: 0xff1b },
			Gtk: {
				Window: FakeWindow,
				HeaderBar: "headerbar",
				EventControllerKey: "key-controller",
			},
		},
		"ags/gtk4/jsx-runtime": {
			jsx: (type, props) => {
				const made = make(type, props)
				if (made instanceof FakeWindow) windows.push(made)
				return made
			},
			jsxs: (type, props) => {
				const made = make(type, props)
				if (made instanceof FakeWindow) windows.push(made)
				return made
			},
		},
		"$lib/app": { default: { name: "app" } },
		"$lib/time": {
			idle: (callback) => {
				idles.push(callback)
				return { cancel() {} }
			},
		},
		"./IconPicker": {
			IconPicker: (props) => {
				pickers.push(props)
				return { type: "icon_picker", props, children: [] }
			},
		},
	})
	const picked: string[] = []
	choose_icon({ get_root: () => parent }, (name) => picked.push(name))
	return {
		window: windows[0],
		picker: pickers[0],
		picked,
		idles,
		disposed,
		parent,
	}
}

test("choosing an icon opens a modal window over its parent with an active picker", async () => {
	const f = await fixture()
	assert.equal(f.window.presented, 1)
	assert.equal(f.window.props.transientFor, f.parent)
	assert.equal(f.window.props.modal, true)
	assert.equal(f.window.props.defaultWidth, 484)
	assert.equal(f.window.props.defaultHeight, 310)
	assert.equal(f.window.props.title, "Pick an Icon")
	assert.equal(f.window.props.class, "dialog icon-chooser")
	assert.equal(f.picker.active(), true)
	const [header] = nodes(f.window.children, "headerbar")
	assert.equal(header.props.$type, "titlebar")
	assert.equal(header.props.showTitleButtons, false)
	assert.equal(nodes(header, "button")[0].props.label, "Cancel")
})

test("picking reports the icon, closes the window and disposes after idle", async () => {
	const f = await fixture()
	f.picker.on_pick("folder")
	assert.deepEqual(f.picked, ["folder"])
	assert.equal(f.window.closed, 1)
	assert.equal(f.picker.active(), false)
	assert.deepEqual(f.disposed, [])
	for (const callback of f.idles.splice(0)) callback()
	assert.deepEqual(f.disposed, [1])
})

test("escape and cancel close without picking", async () => {
	const f = await fixture()
	const [controller] = nodes(f.window.children, "key-controller")
	assert.equal(controller.props.onKeyPressed(null, 0x61), false)
	assert.equal(f.window.closed, 0)
	assert.equal(controller.props.onKeyPressed(null, 0xff1b), true)
	assert.equal(f.window.closed, 1)
	nodes(f.window.children, "button")[0].props.onClicked()
	assert.equal(f.window.closed, 2)
	assert.deepEqual(f.picked, [])
})
