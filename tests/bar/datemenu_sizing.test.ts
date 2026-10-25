import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test, { mock } from "node:test"
import ts from "../typescript.ts"
import { load_module } from "../load_module.ts"
import { accessor, create_state, nodes } from "../helpers.ts"

test.afterEach(() => mock.restoreAll())

const source = readFileSync(
	new URL("../../widget/Bar/components/DateMenu/index.tsx", import.meta.url),
	"utf8",
)
const ast = ts.createSourceFile(
	"index.tsx",
	source,
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TSX,
)
const layout = ast.statements.filter(
	(statement) =>
		(ts.isClassDeclaration(statement) &&
			statement.name?.text === "DateMenuColumns") ||
		(ts.isVariableStatement(statement) &&
			statement.declarationList.declarations.some(
				(declaration) =>
					declaration.name.getText(ast) === "RegisteredDateMenuColumns",
			)),
)
assert.equal(layout.length, 2)
const implementation = ts.transpileModule(
	layout.map((statement) => statement.getText(ast)).join("\n"),
	{
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
		},
	},
).outputText

function available(command) {
	try {
		execFileSync("which", [command], { stdio: "ignore" })
		return true
	} catch {
		return false
	}
}

test(
	"datetime alone determines both equal halves and height under native GTK",
	{
		skip: !available("gjs") || !available("xvfb-run"),
	},
	() => {
		const script = `
const gi = imports.gi
gi.versions.Gtk = "4.0"
gi.versions.Gdk = "4.0"
const { Gtk, Gdk, GObject, Gsk, Graphene, GLib } = gi
Gtk.init()
${implementation}
const notifications = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
const header = new Gtk.Label({ label: "Notifications" })
const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vexpand: true })
const contents = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
scroll.set_child(contents)
notifications.append(header)
notifications.append(scroll)
const date = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
const clock = new Gtk.Label({ label: "12:45" })
const calendar = new Gtk.Calendar()
date.append(clock)
date.append(calendar)
const columns = new RegisteredDateMenuColumns()
columns.set_columns(notifications, new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }), date)
const outer = new Gtk.Box({ css_classes: ["datemenu", "horizontal"] })
outer.append(columns)
const css = new Gtk.CssProvider()
const rule = "box.datemenu { padding: 8px; border: 1px solid black; }"
css.load_from_data(rule, rule.length)
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
const window = new Gtk.Window()
window.set_child(outer)
window.present()
const context = GLib.MainContext.default()
function flush() { while (context.pending()) context.iteration(false) }
flush()
function sizes() {
    const width = outer.measure(Gtk.Orientation.HORIZONTAL, -1)[1]
    const height = outer.measure(Gtk.Orientation.VERTICAL, width)[1]
    window.set_default_size(width, height)
    const loop = new GLib.MainLoop(null, false)
    const deadline = GLib.get_monotonic_time() + 5000000
    let configured = false
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        configured = window.get_width() >= width && window.get_height() >= height &&
            columns.get_width() >= columns.measure(Gtk.Orientation.HORIZONTAL, -1)[0] &&
            columns.get_height() >= columns.measure(Gtk.Orientation.VERTICAL, columns.get_width())[0]
        if (configured || GLib.get_monotonic_time() >= deadline) {
            loop.quit()
            return GLib.SOURCE_REMOVE
        }
        return GLib.SOURCE_CONTINUE
    })
    loop.run()
    if (!configured) throw new Error("Window did not configure to " + width + "x" + height +
        "; window " + window.get_width() + "x" + window.get_height() +
        "; outer " + outer.get_width() + "x" + outer.get_height())
    return { width, height, column_width: columns.get_width(), column_height: columns.get_height(),
        left: notifications.get_width(), right: date.get_width(),
        left_height: notifications.get_height(), right_height: date.get_height() }
}
const initial = sizes()
contents.append(new Gtk.Label({ label: "Large text ".repeat(200), wrap: true }))
contents.append(new Gtk.DrawingArea({ content_width: 1600, content_height: 1400 }))
const overflow = sizes()
clock.set_markup("<span size='128000'>12:45</span>")
const grown_font = sizes()
calendar.set_size_request(grown_font.right + 100, grown_font.height + 100)
const grown_calendar = sizes()
const loop = new GLib.MainLoop(null, false)
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => { loop.quit(); return GLib.SOURCE_REMOVE })
loop.run()
flush()
function render_nodes(widget) {
    const snapshot = new Gtk.Snapshot()
    Gtk.WidgetPaintable.new(widget).snapshot(snapshot, widget.get_width(), widget.get_height())
    const node = snapshot.to_node()
    const types = []
    function visit(current) {
        if (!current) return
        types.push(current.get_node_type())
        if (typeof current.get_n_children === "function") {
            for (let i = 0; i < current.get_n_children(); i++) visit(current.get_child(i))
        } else if (typeof current.get_child === "function") visit(current.get_child())
    }
    visit(node)
    return { nodes: types.length, text: types.filter(type => type === Gsk.RenderNodeType.TEXT_NODE).length }
}
const render = { outer: render_nodes(outer), columns: render_nodes(columns), notifications: render_nodes(notifications),
    date: render_nodes(date) }
print(JSON.stringify({ initial, overflow, grown_font, grown_calendar, render }))
window.set_child(null)
outer.remove(columns)
if (columns.get_first_child() !== null) throw new Error("DateMenu children survived unparenting")
window.destroy()
`
		const run = spawnSync("xvfb-run", ["-a", "gjs", "-c", script], {
			encoding: "utf8",
			timeout: 30000,
			stdio: ["ignore", "pipe", "pipe"],
		})
		assert.equal(run.status, 0, run.stderr)
		assert.doesNotMatch(run.stderr, /Gtk-(?:WARNING|CRITICAL)|Gjs-CRITICAL/)
		const { initial, overflow, grown_font, grown_calendar, render } =
			JSON.parse(run.stdout.trim())
		for (const size of [initial, overflow, grown_font, grown_calendar]) {
			assert.equal(size.left, size.right)
			assert.equal(size.left + size.right < size.width, true)
			assert.equal(size.left_height, size.column_height)
			assert.equal(size.right_height, size.column_height)
		}
		assert.deepEqual(
			[overflow.width, overflow.height],
			[initial.width, initial.height],
		)
		assert.ok(
			grown_font.width > initial.width,
			JSON.stringify({ initial, grown_font }),
		)
		assert.ok(
			grown_font.height > initial.height,
			JSON.stringify({ initial, grown_font }),
		)
		assert.ok(
			grown_calendar.width > grown_font.width,
			JSON.stringify({ grown_font, grown_calendar }),
		)
		assert.ok(
			grown_calendar.height > grown_font.height,
			JSON.stringify({ grown_font, grown_calendar }),
		)
		assert.ok(
			render.date.text > 0 && render.notifications.text > 0,
			JSON.stringify(render),
		)
		assert.ok(
			render.columns.text >= render.date.text + render.notifications.text,
			JSON.stringify(render),
		)
		assert.ok(render.outer.text >= render.columns.text, JSON.stringify(render))
		console.log(
			JSON.stringify({ initial, overflow, grown_font, grown_calendar, render }),
		)
	},
)

test("default center follows the bar edge, not the screen center", () => {
	const namespace = ast.statements.find(
		(statement) =>
			ts.isModuleDeclaration(statement) && statement.name.text === "DateMenu",
	)
	const window = namespace.body.statements.find(
		(statement) =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === "Window",
	)
	assert.ok(window)
	let popup
	function find_popup(node) {
		if (
			ts.isJsxOpeningElement(node) &&
			node.tagName.getText(ast) === "PopupWindow"
		)
			popup = node
		ts.forEachChild(node, find_popup)
	}
	find_popup(window)
	assert.ok(popup)
	const attribute = popup.attributes.properties.find(
		(property) =>
			ts.isJsxAttribute(property) && property.name.text === "layout",
	)
	assert.ok(attribute && ts.isJsxExpression(attribute.initializer))
	const call = attribute.initializer.expression
	assert.ok(ts.isCallExpression(call))
	assert.equal(call.expression.getText(ast), "create_popup_position")
	assert.deepEqual(
		call.arguments.map((argument) => argument.getText(ast)),
		["options.bar.position", "options.datemenu.position"],
	)
	const position_source = readFileSync(
		new URL("../../widget/shared/PopupWindow.tsx", import.meta.url),
		"utf8",
	)
	const position_ast = ts.createSourceFile(
		"PopupWindow.tsx",
		position_source,
		ts.ScriptTarget.Latest,
		true,
	)
	const function_node = position_ast.statements.find(
		(statement) =>
			ts.isFunctionDeclaration(statement) &&
			statement.name?.text === "create_popup_position",
	)
	assert.ok(function_node)
	const compiled = ts.transpileModule(
		function_node.getText(position_ast).replace(/^export /, ""),
		{
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
		},
	).outputText
	const position = new Function(
		"createComputed",
		`${compiled}; return create_popup_position`,
	)((fn) => fn)
	for (const bar of ["top-center", "bottom-center"])
		for (const selected of ["center", "top-center", "bottom-center"])
			assert.equal(
				position(
					() => bar,
					() => selected,
				)(),
				`${bar.split("-")[0]}-center`,
			)
})

async function datemenu_fixture() {
	const [count, set_count] = [
		{ value: 0 },
		(value: number) => {
			count.value = value
		},
	]
	const intervals: { ms: number; callback: () => void; cancelled: boolean }[] =
		[]
	const cleanups: (() => void)[] = []
	let toggle
	let uptime_text = "3725.4 9000.1"
	let dismiss_all = 0
	const make = (type, props: Record<string, any> = {}) => {
		if (typeof type === "function") return type(props)
		return {
			type,
			props,
			children: (Array.isArray(props.children)
				? props.children
				: [props.children]
			).filter(Boolean),
			set_parent() {},
		}
	}
	const { DateMenu } = await load_module(
		"widget/Bar/components/DateMenu/index.tsx",
		{
			"$lib/app": { default: {} },
			"ags/gtk4": {
				Astal: { Exclusivity: { EXCLUSIVE: 2 } },
				Gtk: {
					Widget: class {
						connect() {}
					},
					Align: { CENTER: 1 },
					PolicyType: { NEVER: 2 },
					Orientation: { VERTICAL: 1, HORIZONTAL: 0 },
					Separator: "separator",
					ScrolledWindow: "scrolled",
					Calendar: "calendar",
				},
			},
			"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
			"ags/gobject": { default: { registerClass: (cls) => cls } },
			ags: {
				createComputed: (fn) => accessor(fn),
				createState: create_state,
				onCleanup: (fn) => cleanups.push(fn),
			},
			"ags/time": {
				createPoll: () =>
					accessor(() => ({ format: (pattern) => `formatted ${pattern}` })),
			},
			"ags/file": {
				readFile: (path) => {
					assert.equal(path, "/proc/uptime")
					if (uptime_text === "throw") throw new Error("denied")
					return uptime_text
				},
			},
			"gi://GLib": { default: { DateTime: { new_now_local: () => ({}) } } },
			"gi://Graphene": { default: {} },
			"gi://Gsk": { default: {} },
			"widget/shared/Placeholder": {
				Placeholder: (props) => make("placeholder", props),
			},
			"widget/shared/PopupWindow": {
				create_popup_position: (bar, popup) => `${bar()}|${popup()}`,
				PopupWindow: (props) => make("popup", props),
			},
			"../Notifications": {
				Notifications: {
					pending: accessor(() => Array(count.value).fill({})),
					NotificationList: (props) => make("list", props),
					animate_dismiss_all: () => {
						dismiss_all++
					},
				},
			},
			"../PanelButton": { PanelButton: (props) => make("panel-button", props) },
			"$lib/windowing": {
				on_window_toggle: (name, callback) => {
					assert.equal(name, "datemenu")
					toggle = callback
					return () => {
						toggle = null
					}
				},
			},
			"$lib/time": {
				interval: (ms, callback) => {
					const timer = {
						ms,
						callback,
						cancelled: false,
						cancel() {
							this.cancelled = true
						},
					}
					intervals.push(timer)
					callback()
					return timer
				},
			},
			"$shell/options": {
				default: {
					bar: {
						position: accessor(() => "top-center"),
						date: { format: accessor(() => "%a") },
					},
					datemenu: { position: accessor(() => "center") },
					transition: { duration: 0 },
				},
			},
		},
	)
	return {
		DateMenu,
		intervals,
		set_count,
		set_uptime: (text) => {
			uptime_text = text
		},
		toggle: (visible) => toggle({ visible }),
		toggled: () => toggle !== null,
		dismiss_all: () => dismiss_all,
		cleanup: () => {
			for (const cleanup of cleanups) cleanup()
		},
	}
}

test("the date menu shows the clock and uptime only while open and clears notifications", async () => {
	const errors: unknown[][] = []
	mock.method(console, "error", (...args) => {
		if (String(args[0]).startsWith("datemenu")) errors.push(args)
	})
	const f = await datemenu_fixture()
	const button = f.DateMenu.Button()
	assert.equal(button.props.target_window, "datemenu")
	assert.equal(button.children[0].props.label(), "formatted %a")
	const window = f.DateMenu.Window()
	assert.equal(window.props.name, "datemenu")
	assert.equal(window.props.attach_to_bar, true)
	assert.equal(window.props.exclusivity, undefined)
	assert.equal(window.props.layout, "top-center|center")
	const columns = window.children[0].children[0]
	const all = nodes([columns.notifications, columns.date])
	const clock = all.find((node) => node.props.class === "clock")
	const uptime = all.find((node) => node.props.class === "uptime")
	assert.equal(clock.props.label(), "")
	assert.equal(uptime.props.label(), "uptime: 0:00")
	f.toggle(true)
	assert.equal(clock.props.label(), "formatted %H:%M")
	assert.equal(uptime.props.label(), "uptime: 1:02")
	assert.deepEqual(
		f.intervals.map((timer) => [timer.ms, timer.cancelled]),
		[[60_000, false]],
	)
	f.set_uptime("36065.0 1")
	f.intervals[0].callback()
	assert.equal(uptime.props.label(), "uptime: 10:01")
	f.set_uptime("garbage")
	f.intervals[0].callback()
	assert.equal(uptime.props.label(), "uptime: 10:01")
	assert.deepEqual(errors, [])
	f.set_uptime("throw")
	f.intervals[0].callback()
	assert.equal(errors.length, 1)
	assert.equal(errors[0][0], "datemenu.uptime: Failed to read uptime")
	assert.equal(uptime.props.label(), "uptime: 10:01")
	f.toggle(false)
	assert.equal(clock.props.label(), "")
	assert.deepEqual(
		f.intervals.map((timer) => timer.cancelled),
		[true],
	)
	const clear = all.find(
		(node) => node.type === "button" && node.props.onClicked,
	)
	const trash = nodes(clear).find((node) => node.type === "image")
	const placeholder = all.find((node) => node.type === "revealer")
	assert.equal(clear.props.sensitive(), false)
	assert.equal(trash.props.iconName(), "user-trash-symbolic")
	assert.equal(placeholder.props.revealChild(), true)
	f.set_count(2)
	assert.equal(clear.props.sensitive(), true)
	assert.equal(trash.props.iconName(), "user-trash-full-symbolic")
	assert.equal(placeholder.props.revealChild(), false)
	clear.props.onClicked()
	assert.equal(f.dismiss_all(), 1)
	const list = all.find((node) => node.type === "list")
	assert.equal(list.props.persistent, true)
	assert.equal(list.props.class, "notification-list vertical")
	f.toggle(true)
	f.cleanup()
	assert.equal(f.intervals.at(-1)?.cancelled, true)
	assert.equal(f.toggled(), false)
})
