import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")

function compiled_functions(path, names) {
	const source = readFileSync(new URL(path, import.meta.url), "utf8")
	const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
	const namespace = ast.statements.find(ts.isModuleDeclaration)?.body
	const functions = namespace.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name.text))
	assert.equal(functions.length, names.length)
	return ts.transpileModule(functions.map(node => node.getText(ast)).join("\n"), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "h" },
	}).outputText
}

const notifications = compiled_functions("../../widget/Bar/components/Notifications/index.tsx",
	["decode_markup_entities", "body_text", "time_ago", "Header", "Content"])
const date_source = readFileSync(new URL("../../widget/Bar/components/DateMenu/index.tsx", import.meta.url), "utf8")
assert.match(date_source, /hscrollbarPolicy=\{NEVER\}/)
const date_ast = ts.createSourceFile("DateMenu.tsx", date_source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const columns = ts.transpileModule(date_ast.statements.filter(node =>
	ts.isClassDeclaration(node) && node.name?.text === "DateMenuColumns" ||
	ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => decl.name.getText(date_ast) === "RegisteredDateMenuColumns"))
	.map(node => node.getText(date_ast)).join("\n"), {
	compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

function available(command) {
	try { execFileSync("which", [command], { stdio: "ignore" }); return true }
	catch { return false }
}

test("real notification header, text and previews fit calendar-sized GTK columns", {
	skip: !available("gjs") || !available("xvfb-run"),
}, () => {
	const script = `
const gi = imports.gi
gi.versions.Gtk = "4.0"
const { Gtk, Gdk, GObject, Gsk, Graphene, GLib, Pango } = gi
Gtk.init()
const START = Gtk.Align.START, CENTER = Gtk.Align.CENTER, END = Gtk.Align.END
const VERTICAL = Gtk.Orientation.VERTICAL, HORIZONTAL = Gtk.Orientation.HORIZONTAL
const WORD_CHAR = Pango.WrapMode.WORD_CHAR, EllipsizeMode = Pango.EllipsizeMode
const SWING_RIGHT = Gtk.RevealerTransitionType.SWING_RIGHT
const options = { scale: { as: fn => () => fn(scale) }, transition: { duration: 0 } }
const icons = { ui: { close: "window-close-symbolic" } }
let scale = 100, texture
const minute_ticker = fn => fn()
const createComputed = fn => Object.assign(() => fn(), { as: transform => () => transform(fn()) })
const create_texture_accessor = () => () => texture
function h(type, props, ...children) {
    const widget = typeof type === "string" ? ({ box: Gtk.Box, label: Gtk.Label,
        image: Gtk.Image, revealer: Gtk.Revealer, button: Gtk.Button })[type] : type
    const result = new widget()
    for (const [key, raw] of Object.entries(props || {})) {
        if (key === "children" || key.startsWith("on") || raw === undefined) continue
        const value = typeof raw === "function" ? raw() : raw
        if (key === "class") result.add_css_class(value)
        else result.set_property(key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()), value)
    }
    for (const child of children.flat(Infinity)) {
        if (!child) continue
        if (result instanceof Gtk.Box) result.append(child)
        else if (result instanceof Gtk.Revealer || result instanceof Gtk.Button) result.set_child(child)
    }
    return result
}
${notifications}
${columns}
const css = new Gtk.CssProvider()
const rules = "box.notification { padding: 8px; } box.header { margin-bottom: 4px; } image.app-icon { margin-right: 4px; min-width: 20px; min-height: 20px; } label.app-name { margin-right: 8px; } button.close-button { margin-left: 4px; } picture.preview { margin-right: 8px; } box.history picture.preview { margin-right: 0; margin-top: 8px; } label.summary { margin-right: 8px; } scrolledwindow.notification-scrollable { margin-right: 12px; }"
css.load_from_data(rules, rules.length)
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
const window = new Gtk.Window({ decorated: false })
const date = new Gtk.Box({ orientation: VERTICAL })
date.append(new Gtk.Label({ label: "12:45" }))
date.append(new Gtk.Calendar())
const left = new Gtk.Box({ orientation: VERTICAL })
const header = new Gtk.Box()
header.append(new Gtk.Label({ label: "Notifications", hexpand: true, xalign: 0 }))
header.append(new Gtk.Button({ label: "Clear" }))
left.append(header)
const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true })
const list = new Gtk.Box({ orientation: VERTICAL })
scroll.set_child(list)
left.append(scroll)
const column = new RegisteredDateMenuColumns()
column.set_columns(left, new Gtk.Separator({ orientation: VERTICAL }), date)
window.set_child(column)
window.present()
const context = GLib.MainContext.default()
function flush() { while (context.pending()) context.iteration(false) }
function bounds(widget, ancestor) {
    const result = widget.compute_bounds(ancestor)
    if (!result[0]) throw new Error("Cannot compute bounds")
    return { x: result[1].origin.x, y: result[1].origin.y,
        width: result[1].size.width, height: result[1].size.height }
}
function inside(child, parent) {
    const b = bounds(child, parent)
    return b.x >= -1 && b.y >= -1 && b.x + b.width <= parent.get_width() + 1 &&
        b.y + b.height <= parent.get_height() + 1
}
function inside_horizontal(child, parent) {
    const b = bounds(child, parent)
    return b.x >= -1 && b.x + b.width <= parent.get_width() + 1
}
function check(width, height, dimensions, summary, body) {
    scale = dimensions.scale
    const root_before = [column.measure(HORIZONTAL, -1)[1], column.measure(VERTICAL, -1)[1]]
    const bytes = new GLib.Bytes(new Uint8Array(dimensions.image_width * dimensions.image_height * 4))
    texture = Gdk.MemoryTexture.new(dimensions.image_width, dimensions.image_height,
        Gdk.MemoryFormat.R8G8B8A8, bytes, dimensions.image_width * 4)
    const notification = { summary, body, time: GLib.DateTime.new_now_local().to_unix() }
    const card = new Gtk.Box({ orientation: VERTICAL, css_classes: ["notification"] })
    const card_header = Header({ notification, app_icon: "dialog-information-symbolic",
        app_name: "SCREENSHOT", show_actions: () => true, on_dismiss: () => {} })
    const content = Content({ notification, image_path: "/sample/screenshot.png", persistent: true })
    card.append(card_header)
    card.append(content)
    list.append(card)
    window.set_default_size(width * 2 + column.separator.measure(HORIZONTAL, -1)[1], height)
    flush()
    column.measure(HORIZONTAL, height)
    column.measure(VERTICAL, width * 2 + column.separator.measure(HORIZONTAL, -1)[1])
    column.allocate(width * 2 + column.separator.measure(HORIZONTAL, -1)[1], height, -1, null)
    flush()
    const root_after = [column.measure(HORIZONTAL, -1)[1], column.measure(VERTICAL, -1)[1]]
    const text_box = content.get_first_child()
    const title = text_box.get_first_child(), message = title.get_next_sibling()
    const picture = text_box.get_next_sibling()
    const time = card_header.get_first_child().get_next_sibling().get_next_sibling()
    const close = time.get_next_sibling()
    const result = { width, allocated: [left.get_width(), date.get_width()], root_before, root_after,
        height: column.get_height(), card_width: card.get_width(),
        scroll: [scroll.get_hadjustment().get_upper(), scroll.get_hadjustment().get_page_size()],
        vertical_scroll: [scroll.get_vadjustment().get_upper(), scroll.get_vadjustment().get_page_size()],
        fit: [card, card_header, content, title, message, picture, close].map(widget => inside_horizontal(widget, scroll)),
        picture_in_card: inside(picture, card), text_in_card: [title, message, time, close].map(widget => inside(widget, card)),
        time: time.get_label(), time_width: time.get_width(), time_natural: time.measure(HORIZONTAL, -1)[1],
        summary_lines: title.get_layout().get_line_count(), body_lines: message.get_layout().get_line_count(),
        full_text: [title, message, time].every(widget => widget.get_layout().get_text() === widget.get_label() &&
            !widget.get_layout().is_ellipsized()),
        wrap: [title.get_wrap(), message.get_wrap()],
        tooltip: [message.get_tooltip_text(), picture.get_tooltip_text()],
        picture_size: [picture.get_width(), picture.get_height()],
        source_size: [picture.get_paintable().get_width(), picture.get_paintable().get_height()],
        can_shrink: picture.get_can_shrink() }
    list.remove(card)
    return result
}
const results = []
for (const [width, scale] of [[320, 150], [260, 200]]) {
    results.push(check(width, 420, { scale, image_width: Math.round(260 * scale / 100),
        image_height: Math.round(146 * scale / 100) },
        "Screenshot taken", "Saved to Pictures/Screenshots"))
    results.push(check(width, 420, { scale, image_width: Math.round(45 * scale / 100),
        image_height: Math.round(260 * scale / 100) },
        "Long notification summary that must wrap in the available column instead of growing it",
        "/home/user/Pictures/Screenshots/very-long-original-screenshot-file-name-without-breaks.png"))
}
print(JSON.stringify(results))
window.set_child(null)
if (column.get_first_child() !== null) throw new Error("DateMenu children survived unparenting")
window.destroy()
`
	const run = spawnSync("xvfb-run", ["-a", "-n", String(1000 + process.pid % 10000), "gjs", "-c", script], {
		encoding: "utf8", timeout: 30000, env: { ...process.env, GTK_A11Y: "none" },
	})
	assert.equal(run.status, 0, run.stderr)
	assert.doesNotMatch(run.stderr, /Gtk-(?:WARNING|CRITICAL)|Gjs-CRITICAL/, run.stdout)
	const results = JSON.parse(run.stdout.trim())
	for (const result of results) {
		assert.deepEqual(result.allocated, [result.width, result.width], JSON.stringify(result))
		assert.deepEqual(result.root_after, result.root_before, JSON.stringify(result))
		assert.ok(result.scroll[0] <= result.scroll[1] + 1, JSON.stringify(result))
		assert.ok(result.fit.every(Boolean) && result.picture_in_card && result.text_in_card.every(Boolean), JSON.stringify(result))
		assert.equal(result.time, "now")
		assert.ok(result.time_width >= result.time_natural, JSON.stringify(result))
		assert.ok(result.full_text && result.can_shrink, JSON.stringify(result))
		assert.deepEqual(result.wrap, [true, true])
		assert.equal(result.tooltip[1], "/sample/screenshot.png")
		assert.ok(result.picture_size[0] > 0 && result.picture_size[1] > 0, JSON.stringify(result))
	}
	assert.ok(results[1].summary_lines > 1 && results[1].body_lines > 1, JSON.stringify(results[1]))
	assert.deepEqual(results[1].source_size, [68, 390])
	assert.ok(results[3].vertical_scroll[0] > results[3].vertical_scroll[1], JSON.stringify(results[3]))
	console.log(JSON.stringify(results))
})
