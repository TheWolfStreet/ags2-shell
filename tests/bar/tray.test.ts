import assert from "node:assert/strict"
import test, { mock } from "node:test"
import * as icons from "../../lib/icons.ts"
import { load_module } from "../load_module.ts"
import {
	accessor,
	create_state,
	jsx_runtime,
	nodes,
	read,
	tick,
} from "../helpers.ts"

test.afterEach(() => mock.restoreAll())

function capture_warnings() {
	const warnings: unknown[][] = []
	mock.method(console, "warn", (...args) => warnings.push(args))
	return warnings
}

const tray_icon = {
	get_native: () => ({ get_surface: () => ({}) }),
	get_root: () => ({}),
	get_width: () => 40,
	compute_point: (_root, middle) => [true, { x: 680 + middle.x }],
}

async function tray_fixture({
	is_menu = false,
	has_menu = true,
	menu_path = "/MenuBar" as string | null,
	item_id = "org.example.Tray/StatusNotifierItem",
	call_error = null as Error | null,
	bridged = false,
	icon_name = "",
	themed = [] as string[],
} = {}) {
	const calls: any[][] = []
	const theme_handlers: (() => void)[] = []
	const theme_icons = new Set(themed)
	const popups: boolean[] = []
	const builds: boolean[] = []
	const commands: string[] = []
	const cleanups: (() => void)[] = []
	let is_menu_reads = 0
	const item = {
		title: "Example",
		gicon: "icon",
		iconName: icon_name,
		tooltipText: "Example",
		menuModel: has_menu ? {} : null,
		menuPath: menu_path,
		get_item_id: () => item_id,
		get_is_menu: () => {
			is_menu_reads++
			return is_menu
		},
	}
	const imports = {
		ags: {
			createBinding: (object, property) => accessor(() => object[property]),
			createComputed: (fn) => accessor(fn),
			createState: create_state,
			For: ({ each, children }) => each().map(children),
			onCleanup: (fn) => cleanups.push(fn),
		},
		"ags/gtk4": {
			Gdk: {
				BUTTON_SECONDARY: 3,
				Display: {
					get_default: () => ({
						get_monitor_at_surface: () => ({
							get_geometry: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
						}),
					}),
				},
			},
			Gtk: {
				Align: { CENTER: 1 },
				GestureClick: "gesture-click",
				IconTheme: {
					get_for_display: () => ({
						has_icon: (name: string) => theme_icons.has(name),
						connect: (_signal: string, handler: () => void) =>
							theme_handlers.push(handler),
						disconnect() {},
					}),
				},
			},
		},
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"gi://AstalTray": { default: { get_default: () => ({ items: [item] }) } },
		"gi://Gio": {
			default: {
				DBus: {
					session: {
						call: (...args) => {
							if (call_error) throw call_error
							calls.push(args)
						},
					},
				},
				DBusCallFlags: { NONE: 0 },
				ThemedIcon: { new: (name: string) => `themed:${name}` },
			},
		},
		"gi://Graphene": {
			default: {
				Point: class {
					constructor(fields) {
						Object.assign(this, fields)
					}
				},
			},
		},
		"gi://GLib": {
			default: {
				Variant: class {
					type: unknown
					value: unknown
					constructor(type, value) {
						this.type = type
						this.value = value
					}
				},
			},
		},
		"$shell/options": {
			default: {
				bar: {
					systray: { ignore: () => [] },
					position: { peek: () => "bottom-center" },
				},
				theme: { spacing: { peek: () => 6 } },
				scale: { peek: () => 100 },
			},
		},
		"widget/shared/PopupWindow": { bar_thickness: { peek: () => 40 } },
		"$lib/hyprland": {
			hyprland: {
				get_cursor_position: () => ({ x: 640, y: 1050 }),
				get_clients: () => (bridged ? [{ class: "xembedsniproxy" }] : []),
			},
			hyprland_command: async (message: string) => {
				commands.push(message)
				return { ok: true, value: undefined }
			},
		},
		"./tray_menu": {
			create_tray_menu_popover: () => ({
				popover: { set_parent() {}, popup: () => popups.push(true) },
				ensure_built: () => builds.push(true),
			}),
		},
	}
	const { SystemTray } = await load_module(
		"widget/Bar/components/Buttons/SystemTray.tsx",
		imports,
	)
	const root = SystemTray()
	const [button] = nodes(root, "button")
	const gesture = button.children.find(
		(child) => child.type === "gesture-click",
	)
	return {
		item,
		button,
		gesture,
		calls,
		popups,
		builds,
		commands,
		cleanups,
		is_menu_reads: () => is_menu_reads,
		complete: (index, connection: object = { call_finish() {} }) =>
			calls[index][9](connection, {}),
		icon: () => read(nodes(button, "image")[0].props.gicon),
		change_theme: (names: string[]) => {
			theme_icons.clear()
			for (const name of names) theme_icons.add(name)
			for (const handler of theme_handlers) handler()
		},
	}
}

test("tray icons use the icon theme's version of their name and fall back to the app's own icon", async () => {
	const fixture = await tray_fixture({
		icon_name: "steam_tray_mono",
		themed: ["steam_tray_mono"],
	})
	assert.equal(fixture.icon(), "themed:steam_tray_mono")
	fixture.change_theme([])
	assert.equal(fixture.icon(), "icon")
	fixture.change_theme(["steam_tray_mono"])
	assert.equal(fixture.icon(), "themed:steam_tray_mono")
	const unnamed = await tray_fixture({ themed: ["steam_tray_mono"] })
	assert.equal(unnamed.icon(), "icon")
})

for (const is_menu of [false, true])
	test(`tray left and right click open the menu without activation (is_menu=${is_menu})`, async () => {
		const fixture = await tray_fixture({ is_menu })
		assert.equal(fixture.gesture.props.button, 3)
		fixture.button.props.onClicked()
		fixture.gesture.props.onPressed({ get_widget: () => tray_icon })
		assert.equal(fixture.calls.length, 1)
		assert.equal(fixture.calls[0][0], "org.example.Tray")
		assert.equal(fixture.calls[0][1], "/MenuBar")
		assert.equal(fixture.calls[0][2], "com.canonical.dbusmenu")
		assert.equal(fixture.calls[0][3], "AboutToShow")
		assert.equal(fixture.calls[0][4].type, "(i)")
		assert.deepEqual(fixture.calls[0][4].value, [0])
		assert.equal(fixture.calls[0][7], 1000)
		fixture.complete(0)
		assert.equal(fixture.builds.length, 1)
		assert.equal(fixture.popups.length, 1)
		fixture.gesture.props.onPressed({ get_widget: () => tray_icon })
		fixture.complete(1)
		assert.deepEqual(
			fixture.calls.map((call) => call[3]),
			["AboutToShow", "AboutToShow"],
		)
		assert.equal(fixture.popups.length, 2)
		assert.equal(fixture.is_menu_reads(), 0)
	})

test("tray items without a menu are activated and asked for their own context menu under the icon, one popup gap past the bar", async () => {
	const fixture = await tray_fixture({ has_menu: false })
	fixture.button.props.onClicked(tray_icon)
	await tick()
	fixture.gesture.props.onPressed({ get_widget: () => tray_icon })
	await tick()
	assert.deepEqual(
		fixture.calls.map(([bus_name, path, iface, method, args]) => [
			bus_name,
			path,
			iface,
			method,
			args.value,
		]),
		[
			[
				"org.example.Tray",
				"/StatusNotifierItem",
				"org.kde.StatusNotifierItem",
				"Activate",
				[700, 1032],
			],
			[
				"org.example.Tray",
				"/StatusNotifierItem",
				"org.kde.StatusNotifierItem",
				"ContextMenu",
				[700, 1032],
			],
		],
	)
	fixture.complete(0)
	await tick()
	assert.deepEqual(fixture.commands, [])
	assert.equal(fixture.popups.length, 0)
	assert.equal(fixture.is_menu_reads(), 0)
})

test("a bridged XEmbed icon moves the bridge to the click point before forwarding the click", async () => {
	const fixture = await tray_fixture({ has_menu: false, bridged: true })
	fixture.gesture.props.onPressed({ get_widget: () => tray_icon })
	await tick()
	assert.deepEqual(fixture.commands, [
		'dispatch hl.dsp.window.move({ x = 640, y = 1032, window = "class:^(xembedsniproxy)$" })',
	])
	assert.equal(fixture.calls[0][3], "ContextMenu")
	assert.deepEqual(fixture.calls[0][4].value, [640, 1032])
	fixture.complete(0)
	await tick()
	assert.equal(fixture.commands.length, 1)
	fixture.button.props.onClicked(tray_icon)
	await tick()
	assert.equal(fixture.calls[1][3], "Activate")
	assert.deepEqual(fixture.calls[1][4].value, [640, 1032])
})

test("a failing ContextMenu call warns", async () => {
	const warnings = capture_warnings()
	const failure = new Error("bus gone")
	const fixture = await tray_fixture({ has_menu: false, call_error: failure })
	fixture.gesture.props.onPressed({ get_widget: () => tray_icon })
	await tick()
	assert.deepEqual(warnings, [["tray: ContextMenu failed", failure]])
})

for (const [name, options] of [
	["menu path", { menu_path: null }],
	["bus separator", { item_id: "org.example.Tray" }],
] as const)
	test(`tray item without a ${name} warns and still opens the menu`, async () => {
		const warnings = capture_warnings()
		const fixture = await tray_fixture(options)
		fixture.button.props.onClicked()
		assert.equal(fixture.calls.length, 0)
		assert.deepEqual(warnings, [["tray: Invalid menu address"]])
		assert.equal(fixture.builds.length, 1)
		assert.equal(fixture.popups.length, 1)
		fixture.button.props.onClicked()
		assert.equal(fixture.popups.length, 2)
	})

test("a failing AboutToShow call warns and still opens the menu", async () => {
	const warnings = capture_warnings()
	const failure = new Error("bus gone")
	const fixture = await tray_fixture({ call_error: failure })
	fixture.button.props.onClicked()
	assert.deepEqual(warnings, [["tray: AboutToShow failed", failure]])
	assert.equal(fixture.popups.length, 1)
	fixture.button.props.onClicked()
	assert.equal(fixture.popups.length, 2)
})

test("a failing AboutToShow reply warns and still opens the menu", async () => {
	const warnings = capture_warnings()
	const failure = new Error("no reply")
	const fixture = await tray_fixture()
	fixture.button.props.onClicked()
	assert.equal(fixture.popups.length, 0)
	fixture.complete(0, {
		call_finish() {
			throw failure
		},
	})
	assert.deepEqual(warnings, [["tray: AboutToShow failed", failure]])
	assert.equal(fixture.builds.length, 1)
	assert.equal(fixture.popups.length, 1)
})

test("a menu removed while AboutToShow is pending is not opened", async () => {
	const fixture = await tray_fixture()
	fixture.button.props.onClicked()
	fixture.item.menuModel = null
	fixture.complete(0)
	assert.equal(fixture.builds.length, 0)
	assert.equal(fixture.popups.length, 0)
	fixture.item.menuModel = {}
	fixture.button.props.onClicked()
	assert.equal(fixture.calls.length, 2)
})

test("a tray item cleaned up while AboutToShow is pending stays closed", async () => {
	const fixture = await tray_fixture()
	fixture.button.props.onClicked()
	for (const cleanup of fixture.cleanups) cleanup()
	fixture.complete(0)
	assert.equal(fixture.builds.length, 0)
	assert.equal(fixture.popups.length, 0)
})

test("a hidden tray item does not request its menu", async () => {
	const fixture = await tray_fixture()
	fixture.item.gicon = ""
	fixture.button.props.onClicked()
	assert.equal(fixture.calls.length, 0)
})

class fake_widget {
	kind: string
	props: Record<string, any>
	classes: string[] = []
	children: fake_widget[] = []
	child: fake_widget | null = null
	sensitive = true
	handlers = new Map<string, () => void>()
	constructor(kind: string, props: Record<string, any> = {}) {
		this.kind = kind
		this.props = props
	}
	add_css_class(name: string) {
		this.classes.push(name)
	}
	append(child: fake_widget) {
		this.children.push(child)
	}
	get_last_child() {
		return this.children.at(-1) ?? null
	}
	set_child(child: fake_widget) {
		this.child = child
	}
	set_sensitive(value: boolean) {
		this.sensitive = value
	}
	connect(signal: string, handler: () => void) {
		this.handlers.set(signal, handler)
	}
	click() {
		this.handlers.get("clicked")?.()
	}
	labels(): string[] {
		const own = this.kind === "label" ? [this.props.label] : []
		const nested = [...this.children, ...(this.child ? [this.child] : [])]
		return [...own, ...nested.flatMap((child) => child.labels())]
	}
}

function widget_class(kind: string) {
	return class extends fake_widget {
		constructor(props = {}) {
			super(kind, props)
		}
	}
}

class signal_source {
	handlers = new Map<number, [string, () => void]>()
	next_id = 1
	connect(signal: string, handler: () => void) {
		const id = this.next_id++
		this.handlers.set(id, [signal, handler])
		return id
	}
	disconnect(id: number) {
		this.handlers.delete(id)
	}
	emit(signal: string) {
		for (const [name, handler] of [...this.handlers.values()])
			if (name === signal) handler()
	}
	connected(signal?: string) {
		return [...this.handlers.values()].filter(
			([name]) => signal === undefined || name === signal,
		).length
	}
}

type menu_entry = {
	label?: string
	action?: string
	target?: unknown
	section?: fake_menu
	submenu?: fake_menu
}

class fake_menu extends signal_source {
	entries: menu_entry[]
	constructor(entries: menu_entry[] = []) {
		super()
		this.entries = entries
	}
	get_n_items() {
		return this.entries.length
	}
	link_reads = 0
	get_item_link(index: number, link: string) {
		this.link_reads++
		return this.entries[index][link] ?? null
	}
	get_item_attribute_value(index: number, attribute: string) {
		const value = this.entries[index][attribute]
		if (value === undefined) return null
		if (attribute === "target") return value
		return { get_string: () => [value] }
	}
}

function state(type: string, value: unknown) {
	return {
		get_type_string: () => type,
		get_boolean: () => {
			assert.equal(type, "b", "get_boolean on a non-boolean state")
			return value === true
		},
		equal: (other) => other === value,
	}
}

class fake_group extends signal_source {
	actions: Record<string, { enabled: boolean; state?: unknown }>
	activated: [string, unknown][] = []
	constructor(actions: fake_group["actions"]) {
		super()
		this.actions = actions
	}
	has_action(name: string) {
		return name in this.actions
	}
	get_action_enabled(name: string) {
		return this.actions[name].enabled
	}
	get_action_state(name: string) {
		return this.actions[name].state ?? null
	}
	activate_action(name: string, target: unknown) {
		this.activated.push([name, target])
	}
}

type fake_popover = {
	position: number
	parent: fake_widget | null
	mapped: boolean
	events: string[]
	revealer: fake_widget
}

async function menu_fixture({
	model = new fake_menu() as fake_menu | null,
	group = null as fake_group | null,
} = {}) {
	const popovers: fake_popover[] = []
	const idles: { callback: () => void; cancelled: boolean }[] = []
	const cleanups: (() => void)[] = []
	const item = Object.assign(new signal_source(), {
		menuModel: model,
		actionGroup: group,
	})
	const imports = {
		ags: { onCleanup: (fn) => cleanups.push(fn) },
		"ags/gtk4": {
			Gtk: {
				Orientation: { VERTICAL: "vertical", HORIZONTAL: "horizontal" },
				PositionType: { BOTTOM: "bottom", RIGHT: "right" },
				Align: { START: "start", CENTER: "center" },
				Button: widget_class("button"),
				Box: widget_class("box"),
				Label: widget_class("label"),
				Image: widget_class("image"),
				Separator: widget_class("separator"),
			},
		},
		"$lib/time": {
			idle: (callback) => {
				const timer = { callback, cancelled: false }
				idles.push(timer)
				return {
					cancel: () => {
						timer.cancelled = true
					},
				}
			},
		},
		"gi://GLib": { default: { VariantType: { new: (type) => type } } },
		"widget/shared/animated_popover": {
			create_animated_popover: (position) => {
				const revealer = new fake_widget("revealer")
				const popover = {
					position,
					parent: null as fake_widget | null,
					mapped: false,
					events: [] as string[],
					revealer,
					set_parent(parent) {
						this.parent = parent
					},
					unparent() {
						this.events.push("unparent")
					},
					popup() {
						this.events.push("popup")
					},
					popdown() {
						this.events.push("popdown")
					},
					get_mapped() {
						return this.mapped
					},
				}
				popovers.push(popover)
				return {
					popover,
					revealer,
					dispose: () => popover.events.push("dispose"),
				}
			},
			follow_bar_position: (popover) => {
				popover.events.push("follow")
				return () => popover.events.push("unfollow")
			},
		},
	}
	const { create_tray_menu_popover } = await load_module(
		"widget/Bar/components/Buttons/tray_menu.tsx",
		imports,
	)
	const created = create_tray_menu_popover(item)
	const root = popovers[0]
	return {
		...created,
		item,
		root,
		popovers,
		idles,
		menu: () => root.revealer.child as fake_widget,
		run_idles: () => {
			for (const timer of idles.splice(0))
				if (!timer.cancelled) timer.callback()
		},
		cleanup: () => {
			for (const cleanup of cleanups) cleanup()
		},
	}
}

test("tray menu items mirror labels, sensitivity and check state", async () => {
	const group = new fake_group({
		open: { enabled: true },
		toggle: { enabled: true, state: state("b", true) },
		off: { enabled: true, state: state("b", false) },
		mode: { enabled: true, state: state("s", "a") },
		disabled: { enabled: false },
	})
	const model = new fake_menu([
		{ label: "_Open", action: "app.open" },
		{ label: "Toggle", action: "app.toggle" },
		{ label: "Off", action: "app.off" },
		{ label: "Mode A", action: "app.mode", target: "a" },
		{ label: "Mode B", action: "app.mode", target: "b" },
		{ label: "Plain mode", action: "app.mode" },
		{ label: "Disabled", action: "app.disabled" },
		{ label: "Missing", action: "app.missing" },
		{ label: "Bare", action: "bare" },
		{},
	])
	const fixture = await menu_fixture({ model, group })
	assert.equal(fixture.root.position, "bottom")
	fixture.ensure_built()
	const menu = fixture.menu()
	assert.deepEqual(menu.classes, ["tray-menu"])
	assert.equal(menu.props.orientation, "vertical")
	assert.deepEqual(menu.labels(), [
		"_Open",
		"Toggle",
		"Off",
		"Mode A",
		"Mode B",
		"Plain mode",
		"Disabled",
		"Missing",
		"Bare",
		"",
	])
	const buttons = menu.children
	assert.deepEqual(
		buttons.map((button) => button.sensitive),
		[true, true, true, true, true, true, false, false, false, false],
	)
	assert.deepEqual(
		buttons.map((button) =>
			button.child!.children.some((child) => child.kind === "image"),
		),
		[false, true, false, true, false, false, false, false, false, false],
	)
	const check = buttons[1].child!.children[0]
	assert.equal(check.props.iconName, icons.default.ui.tick)
	assert.deepEqual(check.classes, ["check"])
	const label = buttons[0].child!.children[0]
	assert.deepEqual(label.props, {
		label: "_Open",
		useUnderline: true,
		xalign: 0,
		halign: "start",
		hexpand: true,
	})
	assert.deepEqual(buttons[0].classes, ["model-item"])
})

test("tray menu items activate their action and close the menu", async () => {
	const group = new fake_group({ mode: { enabled: true } })
	const model = new fake_menu([
		{ label: "Mode", action: "app.mode", target: "b" },
		{ label: "Missing", action: "app.missing" },
	])
	const fixture = await menu_fixture({ model, group })
	fixture.ensure_built()
	const [known, missing] = fixture.menu().children
	known.click()
	assert.deepEqual(group.activated, [["mode", "b"]])
	assert.deepEqual(fixture.root.events, ["follow", "popdown"])
	missing.click()
	assert.deepEqual(group.activated, [["mode", "b"]])
	assert.deepEqual(fixture.root.events, ["follow", "popdown", "popdown"])
})

test("tray menu items without an action group are inert", async () => {
	const model = new fake_menu([{ label: "Open", action: "app.open" }])
	const fixture = await menu_fixture({ model })
	fixture.ensure_built()
	const [button] = fixture.menu().children
	assert.equal(button.sensitive, false)
	button.click()
	assert.deepEqual(fixture.root.events, ["follow", "popdown"])
})

test("tray menu sections are separated only after existing items", async () => {
	const model = new fake_menu([
		{ section: new fake_menu([{ label: "A" }]) },
		{ label: "B" },
		{ section: new fake_menu([{ label: "C" }, { label: "D" }]) },
		{ section: new fake_menu([]) },
		{ section: new fake_menu([{ label: "E" }]) },
	])
	const fixture = await menu_fixture({ model })
	fixture.ensure_built()
	assert.deepEqual(
		fixture.menu().children.map((child) => child.labels()[0] ?? child.kind),
		["A", "B", "separator", "C", "D", "separator", "separator", "E"],
	)
})

test("tray submenus open their own popover and close the whole menu", async () => {
	const group = new fake_group({ inner: { enabled: true } })
	const model = new fake_menu([
		{
			label: "More",
			submenu: new fake_menu([{ label: "Inner", action: "app.inner" }]),
		},
	])
	const fixture = await menu_fixture({ model, group })
	fixture.ensure_built()
	const [button] = fixture.menu().children
	assert.deepEqual(button.classes, ["model-item", "submenu"])
	const [label, arrow] = button.child!.children
	assert.equal(label.props.label, "More")
	assert.equal(arrow.props.iconName, icons.default.ui.next)
	const submenu = fixture.popovers[1]
	assert.equal(submenu.position, "right")
	assert.equal(submenu.parent, button)
	button.click()
	assert.deepEqual(submenu.events, ["popup"])
	const inner = submenu.revealer.child!
	assert.deepEqual(inner.classes, ["tray-menu"])
	inner.children[0].click()
	assert.deepEqual(group.activated, [["inner", null]])
	assert.deepEqual(submenu.events, ["popup", "popdown"])
	assert.deepEqual(fixture.root.events, ["follow", "popdown"])
})

test("tray menu traversal stops at cycles, depth 16 and 200 items", async () => {
	const cyclic = new fake_menu([{ label: "Loop" }])
	cyclic.entries.push({ section: cyclic }, { submenu: cyclic, label: "Again" })
	const cycle = await menu_fixture({ model: cyclic })
	cycle.ensure_built()
	assert.deepEqual(cycle.menu().labels(), ["Loop", "Again"])
	assert.equal(cycle.popovers[1].revealer.child!.children.length, 0)
	assert.equal(cyclic.connected("items-changed"), 1)

	let deep = new fake_menu([{ label: "17" }])
	for (let level = 16; level >= 0; level--)
		deep = new fake_menu([{ label: `${level}` }, { section: deep }])
	const nested = await menu_fixture({ model: deep })
	nested.ensure_built()
	assert.equal(nested.menu().labels().length, 17)
	assert.equal(nested.menu().labels().at(-1), "16")

	const wide = new fake_menu(
		Array.from({ length: 250 }, (_value, index) => ({ label: `${index}` })),
	)
	const budget = await menu_fixture({ model: wide })
	budget.ensure_built()
	assert.equal(budget.menu().children.length, 200)
})

test("tray menu watches linked models within the same limits", async () => {
	let deep = new fake_menu([])
	const chain = [deep]
	for (let level = 0; level < 20; level++) {
		deep = new fake_menu([{ submenu: deep }])
		chain.unshift(deep)
	}
	await menu_fixture({ model: deep })
	assert.deepEqual(
		chain.map((model) => model.connected("items-changed")),
		chain.map((_model, depth) => (depth <= 16 ? 1 : 0)),
	)

	const sections = Array.from(
		{ length: 3 },
		() =>
			new fake_menu(
				Array.from({ length: 150 }, () => ({ section: new fake_menu() })),
			),
	)
	const wide = new fake_menu(sections.map((section) => ({ section })))
	await menu_fixture({ model: wide })
	const watched = sections.flatMap((section) =>
		section.entries.map((entry) => entry.section!.connected()),
	)
	assert.equal(watched.filter(Boolean).length, 150 + 47)
	assert.equal(sections[1].link_reads, 48 * 2)
	assert.equal(sections[2].connected(), 0)
})

test("tray menu builds lazily and rebuilds only after changes", async () => {
	const model = new fake_menu([{ label: "A" }])
	const fixture = await menu_fixture({ model })
	assert.equal(fixture.root.revealer.child, null)
	fixture.ensure_built()
	const first = fixture.menu()
	fixture.ensure_built()
	assert.equal(fixture.menu(), first)

	model.entries.push({ label: "B" })
	model.emit("items-changed")
	assert.equal(fixture.idles.length, 0)
	assert.equal(fixture.menu(), first)
	fixture.ensure_built()
	assert.deepEqual(fixture.menu().labels(), ["A", "B"])
	assert.equal(model.connected("items-changed"), 1)
})

test("tray menu changes while open rebuild once on idle", async () => {
	const model = new fake_menu([{ label: "A" }])
	const fixture = await menu_fixture({ model })
	fixture.ensure_built()
	fixture.root.mapped = true
	model.entries.push({ label: "B" })
	model.emit("items-changed")
	model.emit("items-changed")
	assert.equal(fixture.idles.length, 1)
	fixture.run_idles()
	assert.deepEqual(fixture.menu().labels(), ["A", "B"])

	model.emit("items-changed")
	const built = fixture.menu()
	fixture.root.mapped = false
	fixture.run_idles()
	assert.equal(fixture.menu(), built)
})

test("tray menu action signals and item swaps mark the menu dirty", async () => {
	const first = new fake_group({ open: { enabled: false } })
	const model = new fake_menu([{ label: "Open", action: "app.open" }])
	const fixture = await menu_fixture({ model, group: first })
	const signals = [
		"action-added",
		"action-removed",
		"action-enabled-changed",
		"action-state-changed",
	]
	assert.deepEqual(
		signals.map((signal) => first.connected(signal)),
		[1, 1, 1, 1],
	)
	fixture.ensure_built()
	for (const signal of signals) {
		const built = fixture.menu()
		first.emit(signal)
		fixture.ensure_built()
		assert.notEqual(fixture.menu(), built, signal)
	}

	const second = new fake_group({ open: { enabled: true } })
	fixture.item.actionGroup = second
	fixture.item.emit("notify::action-group")
	assert.equal(first.connected(), 0)
	assert.equal(second.connected(), 4)
	fixture.ensure_built()
	assert.equal(fixture.menu().children[0].sensitive, true)

	const replacement = new fake_menu([{ label: "New" }])
	fixture.item.menuModel = replacement
	fixture.item.emit("notify::menu-model")
	assert.equal(model.connected(), 0)
	assert.equal(replacement.connected(), 1)
	fixture.ensure_built()
	assert.deepEqual(fixture.menu().labels(), ["New"])

	fixture.item.menuModel = null
	fixture.item.emit("notify::menu-model")
	fixture.ensure_built()
	assert.equal(fixture.menu().props.orientation, "vertical")
	assert.deepEqual(fixture.menu().classes, [])
})

test("tray menu cleanup releases every connection and popover", async () => {
	const group = new fake_group({})
	const submodel = new fake_menu([{ label: "Inner" }])
	const model = new fake_menu([{ label: "More", submenu: submodel }])
	const fixture = await menu_fixture({ model, group })
	fixture.ensure_built()
	fixture.root.mapped = true
	model.emit("items-changed")
	const pending = fixture.idles[0]
	fixture.ensure_built()
	const old_submenu = fixture.popovers[1]
	assert.deepEqual(old_submenu.events, ["dispose", "unparent"])
	fixture.cleanup()
	assert.equal(pending.cancelled, true)
	assert.equal(fixture.item.connected(), 0)
	assert.equal(model.connected(), 0)
	assert.equal(submodel.connected(), 0)
	assert.equal(group.connected(), 0)
	assert.deepEqual(fixture.popovers[2].events, ["dispose", "unparent"])
	assert.deepEqual(fixture.root.events, [
		"follow",
		"unfollow",
		"dispose",
		"unparent",
	])
	assert.deepEqual(old_submenu.events, ["dispose", "unparent"])
})

test("tray menu renders a model shared by sibling sections each time", async () => {
	const shared = new fake_menu([{ label: "Shared" }])
	const model = new fake_menu([{ section: shared }, { section: shared }])
	const fixture = await menu_fixture({ model })
	fixture.ensure_built()
	assert.deepEqual(fixture.menu().labels(), ["Shared", "Shared"])
})
