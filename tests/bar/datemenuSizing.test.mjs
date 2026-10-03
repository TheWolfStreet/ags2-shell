import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const source = readFileSync(new URL("../../widget/Bar/components/DateMenu/index.tsx", import.meta.url), "utf8")
const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")
const ast = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const layout = ast.statements.filter(statement =>
    ts.isClassDeclaration(statement) && statement.name?.text === "DateMenuColumns" ||
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
        declaration.name.getText(ast) === "RegisteredDateMenuColumns"))
assert.equal(layout.length, 2)
const implementation = ts.transpileModule(layout.map(statement => statement.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText

function available(command) {
    try { execFileSync("which", [command], { stdio: "ignore" }); return true }
    catch { return false }
}

test("datetime alone determines both equal halves and height under native GTK", {
    skip: !available("gjs") || !available("xvfb-run"),
}, () => {
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
        encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    })
    assert.equal(run.status, 0, run.stderr)
    assert.doesNotMatch(run.stderr, /Gtk-(?:WARNING|CRITICAL)|Gjs-CRITICAL/)
    const { initial, overflow, grown_font, grown_calendar, render } = JSON.parse(run.stdout.trim())
    for (const size of [initial, overflow, grown_font, grown_calendar]) {
        assert.equal(size.left, size.right)
        assert.equal(size.left + size.right < size.width, true)
        assert.equal(size.left_height, size.column_height)
        assert.equal(size.right_height, size.column_height)
    }
    assert.deepEqual([overflow.width, overflow.height], [initial.width, initial.height])
    assert.ok(grown_font.width > initial.width, JSON.stringify({ initial, grown_font }))
    assert.ok(grown_font.height > initial.height, JSON.stringify({ initial, grown_font }))
    assert.ok(grown_calendar.width > grown_font.width, JSON.stringify({ grown_font, grown_calendar }))
    assert.ok(grown_calendar.height > grown_font.height, JSON.stringify({ grown_font, grown_calendar }))
    assert.ok(render.date.text > 0 && render.notifications.text > 0, JSON.stringify(render))
    assert.ok(render.columns.text >= render.date.text + render.notifications.text, JSON.stringify(render))
    assert.ok(render.outer.text >= render.columns.text, JSON.stringify(render))
    console.log(JSON.stringify({ initial, overflow, grown_font, grown_calendar, render }))
})

test("default center follows the bar edge, not the screen center", () => {
    const window_body = source.slice(source.indexOf("export function Window()"), source.indexOf("const notification_list"))
    assert.match(window_body, /layout=\{create_popup_position\(options\.bar\.position, options\.datemenu\.position\)\}/)
    const position_source = readFileSync(new URL("../../widget/shared/PopupWindow.tsx", import.meta.url), "utf8")
    const position_ast = ts.createSourceFile("PopupWindow.tsx", position_source, ts.ScriptTarget.Latest, true)
    const function_node = position_ast.statements.find(statement =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "create_popup_position")
    assert.ok(function_node)
    const compiled = ts.transpileModule(function_node.getText(position_ast).replace(/^export /, ""), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    const position = new Function("createComputed", `${compiled}; return create_popup_position`)(fn => fn)
    for (const bar of ["top-center", "bottom-center"])
        for (const selected of ["center", "top-center", "bottom-center"])
            assert.equal(position(() => bar, () => selected)(), `${bar.split("-")[0]}-center`)
})
