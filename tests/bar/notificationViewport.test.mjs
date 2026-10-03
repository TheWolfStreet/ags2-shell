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
	["decode_markup_entities", "body_text", "time_ago", "Header", "Content", "Actions"])
const css_source = execFileSync("sass", ["--stdin", "--load-path=.", "--style=expanded", "--quiet", "--no-source-map"], {
	cwd: new URL("../../", import.meta.url), encoding: "utf8",
	input: '@use "style/base"; @use "widget/Bar/components/DateMenu/style" as *; @use "widget/Bar/components/Notifications/style" as *;',
})
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
	for (const current_scale of [100, 150, 200]) {
	const script = `
const gi = imports.gi
gi.versions.Gtk = "4.0"
const { Gtk, Gdk, GObject, Gsk, Graphene, GLib, Pango } = gi
Gtk.init()
const START = Gtk.Align.START, CENTER = Gtk.Align.CENTER, END = Gtk.Align.END
const VERTICAL = Gtk.Orientation.VERTICAL, HORIZONTAL = Gtk.Orientation.HORIZONTAL
const WORD_CHAR = Pango.WrapMode.WORD_CHAR, EllipsizeMode = Pango.EllipsizeMode
const SWING_RIGHT = Gtk.RevealerTransitionType.SWING_RIGHT
const SWING_DOWN = Gtk.RevealerTransitionType.SWING_DOWN
const options = { scale: { as: fn => () => fn(scale) }, transition: { duration: 0 } }
const icons = { ui: { close: "window-close-symbolic" } }
let scale = ${current_scale}, texture
const minute_ticker = fn => fn()
const createComputed = fn => Object.assign(() => fn(), { as: transform => () => transform(fn()) })
const create_texture_accessor = () => () => texture
const notification_action_available = () => true
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
css.load_from_string(imports.byteArray.toString(GLib.IOChannel.unix_new(0).read_to_end()[1]))
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
const runtime = new Gtk.CssProvider()
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), runtime, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
function style(scale) {
    const size = scale / 100
    runtime.load_from_string('* { --bg: #171717; --fg: #eeeeee; --widget-bg: #303030; --hover-bg: #404040; --border-color: #555555; --popover-border-color: #555555; --primary-bg: #51a4e7; --primary-fg: #141414; --error-bg: #e55f86; --shadow-color: transparent; --neu-widget-highlight: 0 0 0 0 transparent; --neu-widget-shadow: 0 0 0 0 transparent; --neu-button-highlight: 0 0 0 0 transparent; --neu-button-shadow: 0 0 0 0 transparent; --transition: 0ms; --font-name: "SFProDisplay Nerd Font"; --font-size: ' + Math.round(11 * size) + 'pt; --icon-size: ' + Math.round(16 * size) + 'px; --padding: ' + 8 * size + 'pt; --spacing: ' + 6 * size + 'pt; --popover-padding: ' + 12.8 * size + 'pt; --radius: ' + 12 * size + 'px; --popover-radius: ' + 24 * size + 'px; --border-width: ' + size + 'px; }')
}
style(${current_scale})
const window = new Gtk.Window({ decorated: false })
window.set_name('datemenu')
const outer = new Gtk.Box({ css_classes: ['datemenu', 'horizontal'] })
const date = new Gtk.Box({ orientation: VERTICAL, css_classes: ['date-column', 'vertical'] })
const clock_box = new Gtk.Box({ orientation: VERTICAL, css_classes: ['clock-box'] })
clock_box.append(new Gtk.Label({ label: "12:45", css_classes: ['clock'] }))
clock_box.append(new Gtk.Label({ label: 'uptime: 1:23', css_classes: ['uptime'] }))
date.append(clock_box)
const calendar_box = new Gtk.Box({ css_classes: ['calendar'], hexpand: true })
calendar_box.append(new Gtk.Calendar({ halign: CENTER }))
date.append(calendar_box)
const left = new Gtk.Box({ orientation: VERTICAL, vexpand: true, css_classes: ['notifications'] })
const header = new Gtk.Box({ css_classes: ['notifications-header'] })
header.append(new Gtk.Label({ label: "Notifications", hexpand: true, xalign: 0 }))
header.append(new Gtk.Button({ label: "Clear" }))
left.append(header)
const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, css_classes: ['notification-scrollable'] })
const scroll_content = new Gtk.Box({ orientation: VERTICAL, vexpand: true })
const list = new Gtk.Box({ orientation: VERTICAL, valign: START, css_classes: ['notification-list', 'vertical'] })
scroll_content.append(list)
scroll.set_child(scroll_content)
left.append(scroll)
const column = new RegisteredDateMenuColumns()
column.set_columns(left, new Gtk.Separator({ orientation: VERTICAL }), date)
outer.append(column)
window.set_child(outer)
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
    date.set_size_request(width, -1)
    flush()
    const root_before = [outer.measure(HORIZONTAL, -1)[1], outer.measure(VERTICAL, -1)[1]]
    const bytes = new GLib.Bytes(new Uint8Array(dimensions.image_width * dimensions.image_height * 4))
    texture = Gdk.MemoryTexture.new(dimensions.image_width, dimensions.image_height,
        Gdk.MemoryFormat.R8G8B8A8, bytes, dimensions.image_width * 4)
    const notification = { summary, body, time: GLib.DateTime.new_now_local().to_unix() }
    const card = new Gtk.Box({ orientation: VERTICAL, css_classes: ["notification", "normal"] })
    const card_header = Header({ notification, app_icon: "dialog-information-symbolic",
        app_name: "SCREENSHOT", show_actions: () => true, on_dismiss: () => {} })
    const content = Content({ notification, image_path: "/sample/screenshot.png", persistent: true })
    card.append(card_header)
    card.append(content)
    const entry = new Gtk.Revealer({ reveal_child: true, transition_duration: 0 })
    entry.set_child(card)
    list.append(entry)
    window.set_default_size(root_before[0], Math.max(height, root_before[1]))
    flush()
    outer.allocate(root_before[0], Math.max(height, root_before[1]), -1, null)
    flush()
    const root_after = [outer.measure(HORIZONTAL, -1)[1], outer.measure(VERTICAL, -1)[1]]
    const text_box = content.get_first_child()
    const title = text_box.get_first_child(), message = title.get_next_sibling()
    const picture = text_box.get_next_sibling()
    const time = card_header.get_first_child().get_next_sibling().get_next_sibling()
    const close = time.get_next_sibling()
    const dismiss_button = close.get_child()
    const time_bounds = bounds(time, scroll), button_bounds = bounds(dismiss_button, scroll)
    const card_bounds = bounds(card, scroll)
    const result = { width, allocated: [left.get_width(), date.get_width()], root_before, root_after,
        height: column.get_height(), card_width: card.get_width(), outer_width: outer.get_width(),
        column_width: column.get_width(), left_bounds: bounds(left, outer), scroll_bounds: bounds(scroll, outer),
        card_bounds: bounds(card, outer), content_bounds: bounds(content, outer),
        elements: [card, card_header, content, title, message, picture, time, close].map(widget => bounds(widget, scroll)),
        close_gaps: [button_bounds.x - time_bounds.x - time_bounds.width,
            card_bounds.x + card_bounds.width - button_bounds.x - button_bounds.width],
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
    const updated_width = Math.round(600 * scale / 100), updated_height = Math.round(100 * scale / 100)
    picture.set_paintable(Gdk.MemoryTexture.new(updated_width, updated_height,
        Gdk.MemoryFormat.R8G8B8A8, new GLib.Bytes(new Uint8Array(updated_width * updated_height * 4)), updated_width * 4))
    picture.set_size_request(-1, updated_height)
    outer.measure(HORIZONTAL, -1)
    outer.measure(VERTICAL, root_before[0])
    outer.allocate(root_before[0], Math.max(height, root_before[1]), -1, null)
    flush()
    result.updated_picture = bounds(picture, scroll)
    result.updated_root = [outer.measure(HORIZONTAL, -1)[1], outer.measure(VERTICAL, -1)[1]]
    list.remove(entry)
    return result
}
const results = []
for (const [width, scale] of [[320, ${current_scale}]]) {
    results.push(check(width, 420, { scale, image_width: Math.round(260 * scale / 100),
        image_height: Math.round(146 * scale / 100) },
        "Screenshot taken", "Saved to Pictures/Screenshots"))
    results.push(check(width, 420, { scale, image_width: Math.round(45 * scale / 100),
        image_height: Math.round(260 * scale / 100) },
        "Long notification summary that must wrap in the available column instead of growing it",
        "/home/user/Pictures/Screenshots/very-long-original-screenshot-file-name-without-breaks.png"))
}
const popup = new Gtk.Window({ decorated: false, css_classes: ['notifications'] })
popup.set_name('notifications')
popup.set_size_request(Math.round(350 * scale / 100), -1)
const popup_image_size = Math.round(75 * scale / 100)
texture = Gdk.MemoryTexture.new(popup_image_size, popup_image_size, Gdk.MemoryFormat.R8G8B8A8,
    new GLib.Bytes(new Uint8Array(popup_image_size * popup_image_size * 4)), popup_image_size * 4)
const original_popup_margin = new Gtk.CssProvider()
original_popup_margin.load_from_string('window.notifications box.notification button.close-button { margin-left: calc(var(--spacing) / 2); }')
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), original_popup_margin, Gtk.STYLE_PROVIDER_PRIORITY_USER)
const popup_list = new Gtk.Box({ orientation: VERTICAL, css_classes: ['notifications-stack'] })
const popup_card = new Gtk.Box({ orientation: VERTICAL, css_classes: ['notification', 'normal'] })
const popup_notification = { summary: 'Screenshot taken', body: 'Saved to Pictures/Screenshots',
    time: GLib.DateTime.new_now_local().to_unix() }
const popup_header = Header({ notification: popup_notification, app_icon: 'dialog-information-symbolic',
    app_name: 'SCREENSHOT', show_actions: () => false, on_dismiss: () => {} })
const popup_content = Content({ notification: popup_notification, image_path: '/sample/screenshot.png', persistent: false })
popup_card.append(popup_header)
popup_card.append(popup_content)
popup_list.append(popup_card)
popup.set_child(popup_list)
popup.present()
flush()
popup_list.measure(HORIZONTAL, -1)
popup_list.allocate(popup.get_width(), popup_list.measure(VERTICAL, popup.get_width())[1], -1, null)
flush()
const loop = new GLib.MainLoop(null, false)
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => { loop.quit(); return GLib.SOURCE_REMOVE })
loop.run()
flush()
function popup_snapshot() {
    const snapshot = new Gtk.Snapshot()
    Gtk.WidgetPaintable.new(popup_list).snapshot(snapshot, popup_list.get_width(), popup_list.get_height())
    const node = snapshot.to_node()
    return GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, node.serialize())
}
const original_popup = { width: popup.get_width(), list_width: popup_list.get_width(),
    card_width: popup_card.get_width(), snapshot: popup_snapshot() }
Gtk.StyleContext.remove_provider_for_display(Gdk.Display.get_default(), original_popup_margin)
popup_list.measure(HORIZONTAL, -1)
popup_list.measure(VERTICAL, popup_list.get_width())
popup_list.allocate(popup_list.get_width(), popup_list.get_height(), -1, null)
flush()
const popup_time = popup_header.get_first_child().get_next_sibling().get_next_sibling()
const popup_close = popup_time.get_next_sibling()
const hidden = { window_width: popup.get_width(), list_width: popup_list.get_width(), card_width: popup_card.get_width(),
    content_orientation: popup_content.get_orientation(), close_width: popup_close.get_width(),
    preview_size: [popup_content.get_first_child().get_width(), popup_content.get_first_child().get_height()],
    snapshot: popup_snapshot() }
popup_close.set_reveal_child(true)
popup_list.measure(HORIZONTAL, -1)
popup_list.measure(VERTICAL, popup_list.get_width())
popup_list.allocate(popup_list.get_width(), popup_list.get_height(), -1, null)
flush()
const popup_button_bounds = bounds(popup_close.get_child(), popup_list)
const popup_time_bounds = bounds(popup_time, popup_list)
const popup_card_bounds = bounds(popup_card, popup_list)
const popup_result = { original_popup, hidden, shown_card_width: popup_card.get_width(),
    close_gaps: [popup_button_bounds.x - popup_time_bounds.x - popup_time_bounds.width,
        popup_card_bounds.x + popup_card_bounds.width - popup_button_bounds.x - popup_button_bounds.width] }
popup.destroy()
function natural_toast(summary, body, image, actions) {
    const toast = new Gtk.Window({ decorated: false, resizable: false, css_classes: ['notifications'] })
    toast.set_name('notifications')
    toast.set_size_request(Math.round(350 * scale / 100), -1)
    const stack = new Gtk.Box({ orientation: VERTICAL, valign: START, css_classes: ['notifications-stack'] })
    const card = new Gtk.Box({ orientation: VERTICAL, css_classes: ['notification', 'normal'] })
    const notification = { summary, body, time: GLib.DateTime.new_now_local().to_unix() }
    const header = Header({ notification, app_icon: 'dialog-information-symbolic',
        app_name: 'TELEGRAM', show_actions: () => !!actions, on_dismiss: () => {} })
    const content = Content({ notification, image_path: image ? '/sample/screenshot.png' : null, persistent: false })
    card.append(header)
    card.append(content)
    const labels = actions === true ? ['Reply', 'Mark as read'] : actions
    if (actions) card.append(Actions({ actions: labels.map((label, index) => ({ id: String(index), label })),
        persistent: false, show_actions: () => true, on_action_click: () => {} }))
    stack.append(card)
    const viewport = new Gtk.ScrolledWindow({ width_request: Math.round(350 * scale / 100),
        hscrollbar_policy: Gtk.PolicyType.EXTERNAL, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        propagate_natural_height: true })
    viewport.set_child(stack)
    toast.set_child(viewport)
    toast.present()
    const frame = new GLib.MainLoop(null, false)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, () => { frame.quit(); return GLib.SOURCE_REMOVE })
    frame.run()
    flush()
    const text_box = image ? content.get_first_child().get_next_sibling() : content.get_first_child()
    const title = text_box.get_first_child(), message = title.get_next_sibling()
    const action_row = actions ? content.get_next_sibling().get_child() : null
    const action_buttons = []
    if (action_row)
        for (let button = action_row.get_first_child(); button; button = button.get_next_sibling())
            action_buttons.push({ bounds: bounds(button, viewport), text: button.get_child().get_label(),
                lines: button.get_child().get_layout().get_line_count(),
                full_text: button.get_child().get_layout().get_text() === button.get_child().get_label() &&
                    !button.get_child().get_layout().is_ellipsized() })
    const close = header.get_first_child().get_next_sibling().get_next_sibling().get_next_sibling()
    const result = { width: toast.get_width(), height: toast.get_height(), natural: toast.measure(HORIZONTAL, -1),
        viewport: viewport.get_width(), viewport_height: viewport.get_height(),
        scroll: [viewport.get_hadjustment().get_upper(), viewport.get_hadjustment().get_page_size()],
        vertical_scroll: [viewport.get_vadjustment().get_upper(), viewport.get_vadjustment().get_page_size()],
        stack: stack.get_width(), card: bounds(card, viewport), content: bounds(content, viewport),
        summary: bounds(title, viewport), body: bounds(message, viewport),
        actions: action_row ? bounds(action_row, viewport) : null, action_buttons,
        close: bounds(close, viewport),
        lines: [title.get_layout().get_line_count(), message.get_layout().get_line_count()],
        full_text: title.get_layout().get_text() === summary && message.get_layout().get_text() === body &&
            !title.get_layout().is_ellipsized() && !message.get_layout().is_ellipsized() }
    if (action_row && result.vertical_scroll[0] > result.vertical_scroll[1]) {
        viewport.get_vadjustment().set_value(result.vertical_scroll[0] - result.vertical_scroll[1])
        const scrolled = new GLib.MainLoop(null, false)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => { scrolled.quit(); return GLib.SOURCE_REMOVE })
        scrolled.run()
        flush()
        result.last_action_after_scroll = bounds(action_row.get_last_child(), viewport)
    }
    toast.destroy()
    return result
}
const long_body = ('A long message about ordinary plans and details. ').repeat(14) +
    'unbroken' + 'segment'.repeat(35)
const natural_popups = {
    short: natural_toast('Screenshot taken', 'Saved to Pictures/Screenshots', true, false),
    compact_actions: natural_toast('Screenshot taken', 'Saved to Pictures/Screenshots', true,
        ['Open', 'Show in Files', 'Dismiss']),
    long: natural_toast('A long conversation title that must wrap naturally', long_body, false, false),
    with_actions: natural_toast('A long conversation title that must wrap naturally', long_body, true, true),
    long_action: natural_toast('A long conversation title that must wrap naturally', long_body, true,
        ['SyntheticActionLabel'.repeat(5)]),
    many_actions: natural_toast('A long conversation title that must wrap naturally', long_body, true,
        Array.from({ length: 12 }, (_, index) => 'Option ' + (index + 1))),
}
print(JSON.stringify(results))
print(JSON.stringify(popup_result))
print(JSON.stringify(natural_popups))
window.set_child(null)
outer.remove(column)
if (column.get_first_child() !== null) throw new Error("DateMenu children survived unparenting")
window.destroy()
`
	const run = spawnSync("xvfb-run", ["-a", "-n", String(1000 + process.pid % 10000), "gjs", "-c", script], {
		encoding: "utf8", input: css_source, timeout: 30000, env: { ...process.env, GTK_A11Y: "none" },
	})
	assert.equal(run.status, 0, run.stderr)
	assert.doesNotMatch(run.stderr, /Gtk-(?:WARNING|CRITICAL)|Gjs-CRITICAL/, run.stdout)
	const [results, popup, natural_popups] = run.stdout.trim().split("\n").map(JSON.parse)
	assert.equal(natural_popups.short.width, Math.round(350 * current_scale / 100), JSON.stringify(natural_popups))
	assert.deepEqual(natural_popups.compact_actions.content, natural_popups.short.content, JSON.stringify(natural_popups))
	assert.equal(natural_popups.compact_actions.action_buttons.length, 3)
	assert.ok(natural_popups.compact_actions.action_buttons.every(button => button.lines === 1 && button.full_text))
	assert.equal(new Set(natural_popups.compact_actions.action_buttons.map(button => button.bounds.y)).size, 1)
	for (const toast of [natural_popups.long, natural_popups.compact_actions, natural_popups.with_actions,
		natural_popups.long_action, natural_popups.many_actions]) {
		assert.equal(toast.width, natural_popups.short.width, JSON.stringify(natural_popups))
		assert.equal(toast.natural[1], natural_popups.short.width, JSON.stringify(natural_popups))
		assert.ok(toast.full_text, JSON.stringify(natural_popups))
		assert.ok(toast.scroll[0] <= toast.scroll[1] + 1, JSON.stringify(natural_popups))
		assert.ok(toast.body.x >= 0 && toast.body.x + toast.body.width <= toast.viewport, JSON.stringify(natural_popups))
		assert.ok(toast.card.x >= 0 && toast.card.x + toast.card.width <= toast.viewport + 1, JSON.stringify(natural_popups))
		assert.ok(toast.close.x >= 0 && toast.close.x + toast.close.width <= toast.viewport, JSON.stringify(natural_popups))
		if (toast.actions)
			assert.ok(toast.actions.x >= 0 && toast.actions.x + toast.actions.width <= toast.viewport, JSON.stringify(natural_popups))
		for (const button of toast.action_buttons)
			assert.ok(button.full_text && button.bounds.x >= 0 && button.bounds.x + button.bounds.width <= toast.viewport,
				JSON.stringify(natural_popups))
		if (toast.last_action_after_scroll)
			assert.ok(toast.last_action_after_scroll.y >= -1 &&
				toast.last_action_after_scroll.y + toast.last_action_after_scroll.height <= toast.viewport_height + 1,
				JSON.stringify(natural_popups))
	}
	assert.ok(natural_popups.long.lines[0] > 1 && natural_popups.long.lines[1] > 1)
	assert.ok(natural_popups.with_actions.lines[0] > 1 && natural_popups.with_actions.lines[1] > 1)
	assert.ok(natural_popups.long_action.action_buttons[0].lines > 1)
	assert.equal(natural_popups.long_action.action_buttons[0].text, 'SyntheticActionLabel'.repeat(5))
	assert.equal(natural_popups.many_actions.action_buttons.length, 12)
	assert.ok(natural_popups.many_actions.vertical_scroll[0] > natural_popups.many_actions.vertical_scroll[1])
	assert.ok(natural_popups.many_actions.action_buttons.every((button, index, buttons) =>
		index === 0 || button.bounds.y > buttons[index - 1].bounds.y))
	for (const result of results) {
		assert.equal(result.allocated[0], result.allocated[1], JSON.stringify(result))
		assert.deepEqual(result.root_after, result.root_before, JSON.stringify(result))
		assert.ok(result.scroll[0] <= result.scroll[1] + 1, JSON.stringify(result))
		assert.ok(result.fit.every(Boolean) && result.picture_in_card && result.text_in_card.every(Boolean), JSON.stringify(result))
		assert.ok(result.elements[0].x >= -0.05 && result.elements[0].x + result.elements[0].width <= result.scroll[1] + 0.05, JSON.stringify(result))
		assert.ok(Math.abs(result.close_gaps[0] - result.close_gaps[1]) <= 1.5, JSON.stringify(result))
		assert.equal(result.time, "now")
		assert.ok(result.time_width >= result.time_natural, JSON.stringify(result))
		assert.ok(result.full_text && result.can_shrink, JSON.stringify(result))
		assert.deepEqual(result.wrap, [true, true])
		assert.equal(result.tooltip[1], "/sample/screenshot.png")
		assert.ok(result.picture_size[0] > 0 && result.picture_size[1] > 0, JSON.stringify(result))
		assert.ok(result.updated_picture.x >= 0 && result.updated_picture.x + result.updated_picture.width <= result.scroll[1], JSON.stringify(result))
		assert.deepEqual(result.updated_root, result.root_before, JSON.stringify(result))
	}
	assert.ok(results[1].summary_lines > 1 && results[1].body_lines > 1, JSON.stringify(results[1]))
	assert.deepEqual(results[1].source_size, [Math.round(45 * current_scale / 100), Math.round(260 * current_scale / 100)])
	if (current_scale === 200)
		assert.ok(results[1].vertical_scroll[0] > results[1].vertical_scroll[1], JSON.stringify(results[1]))
	assert.equal(popup.hidden.content_orientation, 0, JSON.stringify(popup))
	assert.equal(popup.hidden.close_width, 0, JSON.stringify(popup))
	assert.equal(popup.hidden.window_width, popup.original_popup.width, JSON.stringify(popup))
	assert.equal(popup.hidden.card_width, popup.original_popup.card_width, JSON.stringify(popup))
	assert.equal(popup.hidden.snapshot, popup.original_popup.snapshot, JSON.stringify(popup))
	assert.equal(popup.hidden.card_width, popup.shown_card_width, JSON.stringify(popup))
	assert.deepEqual(popup.hidden.preview_size, [Math.round(75 * current_scale / 100), Math.round(75 * current_scale / 100)])
	assert.ok(Math.abs(popup.close_gaps[0] - popup.close_gaps[1]) <= 1.5, JSON.stringify(popup))
	}
})
