import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(
	execFileSync("which", ["tsc"], { encoding: "utf8" }).trim(),
)
const ts = createRequire(tsc_path)(
	"../lib/node_modules/typescript/lib/typescript.js",
)

async function tray_fixture(is_menu, has_menu = true) {
	const calls = []
	const popups = []
	const builds = []
	let is_menu_reads = 0
	const item = {
		title: "Example",
		gicon: "icon",
		tooltipText: "Example",
		menuModel: has_menu ? {} : null,
		get_item_id: () => "org.example.Tray/StatusNotifierItem",
		get_is_menu: () => {
			is_menu_reads++
			return is_menu
		},
	}
	const accessor = (get) =>
		Object.assign(() => get(), {
			peek: get,
			as: (fn) => accessor(() => fn(get())),
		})
	const make = (type, props = {}) => {
		if (typeof type === "function") return type(props)
		return {
			type,
			props,
			children: (Array.isArray(props.children)
				? props.children
				: [props.children]
			).filter(Boolean),
		}
	}
	const imports = {
		ags: {
			createBinding: (object, property) => accessor(() => object[property]),
			createComputed: (fn) => accessor(fn),
			For: ({ each, children }) => each().map(children),
			onCleanup: () => {},
		},
		"ags/gtk4": {
			Gdk: { BUTTON_SECONDARY: 3 },
			Gtk: { Align: { CENTER: 1 }, GestureClick: "gesture-click" },
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"gi://AstalTray": { default: { get_default: () => ({ items: [item] }) } },
		"gi://Gio": {
			default: {
				DBus: { session: { call: (...args) => calls.push(args) } },
				DBusCallFlags: { NONE: 0 },
			},
		},
		"gi://GLib": {
			default: {
				Variant: class {
					constructor(type, value) {
						this.type = type
						this.value = value
					}
				},
			},
		},
		"$shell/options": { default: { bar: { systray: { ignore: () => [] } } } },
		"./TrayMenu": {
			create_tray_menu_popover: () => ({
				popover: { set_parent() {}, popup: () => popups.push(true) },
				ensure_built: () => builds.push(true),
			}),
		},
	}
	const source = readFileSync(
		new URL(
			"../../widget/Bar/components/Buttons/SystemTray.tsx",
			import.meta.url,
		),
		"utf8",
	)
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
			jsxImportSource: "ags/gtk4",
		},
	}).outputText
	const module = new SourceTextModule(compiled)
	await module.link((name) => {
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name]))
				this.setExport(key, value)
		})
	})
	await module.evaluate()
	const root = module.namespace.SystemTray()
	const button = root.children[0]
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
		is_menu_reads: () => is_menu_reads,
		complete: (index) => calls[index][9]({ call_finish() {} }, {}),
	}
}

for (const is_menu of [false, true]) {
	test(`tray left and right click open the menu without activation (is_menu=${is_menu})`, async () => {
		const fixture = await tray_fixture(is_menu)
		assert.equal(fixture.gesture.props.button, 3)
		fixture.button.props.onClicked()
		fixture.gesture.props.onPressed()
		assert.equal(fixture.calls.length, 1)
		assert.equal(fixture.calls[0][2], "com.canonical.dbusmenu")
		assert.equal(fixture.calls[0][3], "AboutToShow")
		assert.equal(fixture.calls[0][4].type, "(i)")
		assert.deepEqual(fixture.calls[0][4].value, [0])
		fixture.complete(0)
		assert.equal(fixture.builds.length, 1)
		assert.equal(fixture.popups.length, 1)
		fixture.gesture.props.onPressed()
		fixture.complete(1)
		assert.deepEqual(
			fixture.calls.map((call) => call[3]),
			["AboutToShow", "AboutToShow"],
		)
		assert.equal(fixture.popups.length, 2)
		assert.equal(fixture.is_menu_reads(), 0)
	})
}

test("tray clicks without a menu do not request activation", async () => {
	const fixture = await tray_fixture(false, false)
	fixture.button.props.onClicked()
	fixture.gesture.props.onPressed()
	assert.equal(fixture.calls.length, 0)
	assert.equal(fixture.popups.length, 0)
	assert.equal(fixture.is_menu_reads(), 0)
})
