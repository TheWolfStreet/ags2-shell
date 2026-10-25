import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { jsx_runtime } from "../helpers.ts"

async function panel_button_fixture(window_visible: boolean | null) {
	const toggled: unknown[] = []
	const cleanups: (() => void)[] = []
	const listeners = new Map<string, (window) => void>()
	const released: string[] = []
	const window =
		window_visible === null ? null : { is_visible: () => window_visible }
	const module = await load_module("widget/Bar/components/PanelButton.tsx", {
		ags: { onCleanup: (fn) => cleanups.push(fn) },
		"ags/gtk4": { Gtk: { Align: { CENTER: 3 } } },
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"$lib/app": { default: { get_window: () => window } },
		"$lib/ui": {
			toggle_class: (widget, name, enable) =>
				widget.classes.push([name, enable]),
		},
		"$lib/windowing": {
			toggle_window: (name) => toggled.push(name),
			on_window_toggle: (name, fn) => {
				listeners.set(name, fn)
				return () => released.push(name)
			},
		},
	})
	return { module, toggled, cleanups, listeners, released }
}

function mount(node) {
	const self = { classes: [] as unknown[] }
	node.props.$(self)
	return self
}

test("a target window names the button, toggles it and mirrors its visibility", async () => {
	const f = await panel_button_fixture(true)
	const mounted: unknown[] = []
	const node = f.module.PanelButton({
		target_window: "powermenu",
		class: "extra",
		$: (self) => mounted.push(self),
	})
	assert.equal(node.props.name, "powermenu")
	assert.equal(node.props.class, "powermenu extra")
	assert.equal(node.props.canFocus, false)
	assert.equal(node.props.valign, 3)
	node.props.onClicked()
	assert.deepEqual(f.toggled, ["powermenu"])
	const self = mount(node)
	assert.deepEqual(self.classes, [["active", true]])
	assert.deepEqual(mounted, [self])
	f.listeners.get("powermenu")!({ is_visible: () => false })
	assert.deepEqual(self.classes.at(-1), ["active", false])
	for (const cleanup of f.cleanups) cleanup()
	assert.deepEqual(f.released, ["powermenu"])
})

test("a missing target window still subscribes without an initial class", async () => {
	const f = await panel_button_fixture(null)
	const self = mount(f.module.PanelButton({ target_window: "launcher" }))
	assert.deepEqual(self.classes, [])
	assert.ok(f.listeners.has("launcher"))
})

test("a plain button keeps its own click handler and tracks nothing", async () => {
	const f = await panel_button_fixture(true)
	const clicks: unknown[] = []
	const node = f.module.PanelButton({
		name: "media",
		onClicked: () => clicks.push(true),
	})
	assert.equal(node.props.class, "media ")
	node.props.onClicked()
	assert.deepEqual(f.toggled, [])
	assert.deepEqual(clicks, [true])
	const self = mount(node)
	assert.deepEqual(self.classes, [])
	assert.equal(f.listeners.size, 0)
	assert.equal(f.cleanups.length, 0)
})
