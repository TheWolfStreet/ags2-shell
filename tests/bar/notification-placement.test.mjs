import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const root = new URL("../../", import.meta.url)
const sway = process.env.SWAY_HEADLESS_BIN || spawnSync("which", ["sway-unwrapped"], { encoding: "utf8" }).stdout?.trim()
const available = command => spawnSync("which", [command], { stdio: "ignore" }).status === 0
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function stop(child) {
	if (!child?.pid) return
	try { process.kill(-child.pid, "SIGTERM") } catch (error) { if (error.code !== "ESRCH") throw error }
	if (child.exitCode === null && child.signalCode === null)
		await Promise.race([once(child, "exit").catch(() => {}), wait(1000)])
	try { process.kill(-child.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
}

test("real top-right notification surface contains wrapped text, actions and delayed preview", {
	timeout: 60_000,
}, async t => {
	if (!sway || !available("ags") || !available("sass") || !available("tsc"))
		return t.skip("AGS, Sass, TypeScript and headless Sway are required")
	const dir = mkdtempSync(join(tmpdir(), "ags-notification-placement-"))
	try {
		const tsc = realpathSync(spawnSync("which", ["tsc"], { encoding: "utf8" }).stdout.trim())
		const ts = createRequire(tsc)("../lib/node_modules/typescript/lib/typescript.js")
		const source = readFileSync(new URL("../../widget/Bar/components/Notifications/index.tsx", import.meta.url), "utf8")
		const ast = ts.createSourceFile("Notifications.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
		const namespace = ast.statements.find(node => ts.isModuleDeclaration(node) && node.name.text === "Notifications")
		assert.ok(namespace, "production Notifications namespace must be present")
		const lifecycle_source = readFileSync(new URL("../../widget/Bar/components/Notifications/EntryLifecycle.ts", import.meta.url), "utf8")
		const lifecycle_ast = ts.createSourceFile("EntryLifecycle.ts", lifecycle_source, ts.ScriptTarget.Latest, true)
		const lifecycle = lifecycle_ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === "create_entry_lifecycle")
		assert.ok(lifecycle, "production entry lifecycle must be present")
		const entry = join(dir, "fixture.tsx")
		writeFileSync(entry, fixture.replace("INJECT_PRODUCTION", lifecycle.getText(lifecycle_ast) + "\n" + namespace.getText(ast)))
		const css = spawnSync("sass", ["--stdin", "--load-path=.", "--style=expanded", "--quiet", "--no-source-map"], {
			cwd: root, encoding: "utf8",
			input: '@use "style/base"; @use "widget/Bar/components/Notifications/style" as *;',
		})
		assert.equal(css.status, 0, css.stderr)
		const css_path = join(dir, "fixture.css")
		writeFileSync(css_path, css.stdout)
		const bundle_path = join(dir, "fixture")
		const bus_config = join(dir, "dbus.conf")
		writeFileSync(bus_config, '<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen>' +
			'<auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/>' +
			'<allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
		const bundle = spawnSync("ags", ["bundle", entry, bundle_path, "-g", "4", "-r", new URL("../../", import.meta.url).pathname], {
			cwd: root, encoding: "utf8", timeout: 20_000,
		})
		assert.equal(bundle.status, 0, bundle.stderr + bundle.stdout)
		const schema_dirs = ["AstalNotifd-0.1.typelib", "Gtk-4.0.typelib", "GDesktopEnums-3.0.typelib"].map(name => {
			const typelib_dir = process.env.GI_TYPELIB_PATH?.split(":").find(path => existsSync(join(path, name)))
			assert.ok(typelib_dir, `${name} is required for the native fixture`)
			const schemas = join(typelib_dir, "../../share/gsettings-schemas")
			const dirs = readdirSync(schemas).map(child => join(schemas, child))
				.filter(path => existsSync(join(path, "glib-2.0/schemas/gschemas.compiled")))
			assert.equal(dirs.length, 1, `compiled schemas for ${name} must be available`)
			return dirs[0]
		})

		for (const scale of [100, 150]) {
			const runtime = join(dir, `runtime-${scale}`)
			const home = join(dir, `home-${scale}`)
			mkdirSync(runtime, { mode: 0o700 })
			mkdirSync(home, { mode: 0o700 })
			const config = join(dir, `sway-${scale}.conf`)
			writeFileSync(config, "output HEADLESS-1 resolution 960x600\n")
			const env = { ...process.env, XDG_RUNTIME_DIR: runtime, HOME: home,
				XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
				XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
				WLR_BACKENDS: "headless", WLR_RENDERER: "pixman", WLR_LIBINPUT_NO_DEVICES: "1",
				GDK_BACKEND: "wayland", GSK_RENDERER: "cairo", GDK_DISABLE: "vulkan", GTK_A11Y: "none",
				GSETTINGS_BACKEND: "memory", XDG_DATA_DIRS: [...schema_dirs, process.env.XDG_DATA_DIRS].filter(Boolean).join(":"),
				FIXTURE_CSS: css_path, FIXTURE_SCALE: String(scale) }
			delete env.GSETTINGS_SCHEMA_DIR
			for (const key of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE",
				"DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key]
			let compositor, application, sway_log = "", app_log = ""
			try {
				compositor = spawn(sway, ["-c", config], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
				for (const stream of [compositor.stdout, compositor.stderr])
					stream.on("data", chunk => { sway_log = (sway_log + chunk).slice(-8192) })
				const deadline = Date.now() + 6000
				let socket
				while (!socket && Date.now() < deadline && compositor.exitCode === null) {
					socket = readdirSync(runtime).find(name => /^wayland-\d+$/.test(name) && statSync(join(runtime, name)).isSocket())
					if (!socket) await wait(50)
				}
				assert.ok(socket, `private Sway did not start: ${sway_log}`)
				application = spawn("dbus-run-session", ["--config-file=" + bus_config, "--", bundle_path], {
					cwd: root, env: { ...env, WAYLAND_DISPLAY: socket }, detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				})
				for (const stream of [application.stdout, application.stderr])
					stream.on("data", chunk => { app_log = (app_log + chunk).slice(-16384) })
				let timer
				let result
				try {
					result = await Promise.race([
							once(application, "close"),
						new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(
							`fixture timed out at ${scale}%: ${app_log}`)), 12_000) }),
					])
				} finally { clearTimeout(timer) }
				const [code, signal] = result
				assert.equal(code, 0, `fixture exited ${signal ?? code} at ${scale}%: ${app_log}`)
				assert.match(app_log, new RegExp(`PLACEMENT_OK ${scale}\\b`), app_log)
				assert.doesNotMatch(app_log, /(?:Gjs|Gtk|GLib-GObject)-CRITICAL/, app_log)
			} finally {
				await stop(application)
				await stop(compositor)
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

const fixture = `
import { createBinding, createComputed, createRoot, createState, onCleanup } from "ags"
import { createPoll } from "ags/time"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import AstalNotifd from "gi://AstalNotifd"

const scale_number = Number(GLib.getenv("FIXTURE_SCALE"))
const [scale] = createState(scale_number)
const [position] = createState("top-right")
const [transition_duration] = createState(0)
const options = { scale, transition: { duration: transition_duration }, notifications: { position,
    dismiss: { peek: () => 60000 }, blacklist: { subscribe: () => () => {} } } }
const icons = { ui: { close: "window-close-symbolic" }, fallback: { notification: "dialog-information-symbolic" } }
const env = { paths: { home: "/private" } }
const substitute_icon_name = (name: string) => name
const notification_action_available = (_id: string) => true
const active_timers = new Set<number>()
const timeout = (ms: number, fn: () => void) => {
    let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        active_timers.delete(id)
        id = 0
        fn()
        return GLib.SOURCE_REMOVE
    })
    active_timers.add(id)
    return { cancel: () => {
        if (id) { GLib.source_remove(id); active_timers.delete(id); id = 0 }
    } }
}
const attempt = (fn: () => void) => { try { fn(); return { ok: true } } catch (err) { return { ok: false, err } } }
const log_error = (result: { ok: boolean; err?: unknown }) => { if (!result.ok) console.error(result.err) }
const [texture, set_texture] = createState<Gdk.Texture | null>(null)
const classify_image_uri = (_uri: string) => "local"
const create_texture_accessor = (_uri: string, _size: number, _fit: string) => texture
const items: any[] = []
const handlers = new Map<number, { name: string; callback: (...args: any[]) => void }>()
let next_handler = 0
const notification_daemon = {
    get_notifications: () => items,
    get_notification: (id: number) => items.find(item => item.id === id) ?? null,
    connect: (name: string, callback: (...args: any[]) => void) => {
        const id = ++next_handler
        handlers.set(id, { name, callback })
        return id
    },
    disconnect: (id: number) => handlers.delete(id),
    emit: (name: string, id: number) => {
        for (const handler of handlers.values()) if (handler.name === name) handler.callback(notification_daemon, id)
    },
}
const Manager = GObject.registerClass({ Properties: {
    notifications: GObject.ParamSpec.jsobject("notifications", "notifications", "notifications", GObject.ParamFlags.READWRITE),
} }, class Manager extends GObject.Object {
    notifications = []
    session_start = 0
    do_not_disturb = false
    is_blacklisted(_item: unknown) { return false }
})
const notification_manager = new Manager()
const PanelButton = (_props: unknown) => null

INJECT_PRODUCTION

const summary = "A long synthetic title that must wrap within the right-anchored surface"
const body = "UnbrokenSegment".repeat(32) + " plans and details. ".repeat(20)
const long_action = "VeryLongActionWithoutSpaces".repeat(4)
function synthetic(id: number) {
    return { id, time: GLib.DateTime.new_now_local().to_unix() + id, urgency: 1, resident: true,
        summary, body, get_actions: () => [{ id: "one", label: "Open" }, { id: "two", label: long_action }],
        get_image: () => "/private/synthetic.png", get_app_icon: () => "dialog-information-symbolic",
        get_app_name: () => "Synthetic", get_desktop_entry: () => "", get_category: () => "",
        dismiss: () => {}, invoke: () => {} }
}
function children(widget: Gtk.Widget): Gtk.Widget[] {
    const result = []
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) result.push(child)
    return result
}
function walk(widget: Gtk.Widget): Gtk.Widget[] { return [widget, ...children(widget).flatMap(walk)] }
function one(widgets: Gtk.Widget[], name: string) {
    const result = widgets.find(widget => widget.has_css_class(name))
    if (!result) throw Error("missing " + name)
    return result
}
function bounds(widget: Gtk.Widget, window: Gtk.Widget) {
    const [ok, rect] = widget.compute_bounds(window)
    if (!ok) throw Error("cannot compute bounds for " + widget.get_css_classes().join("."))
    return [rect.origin.x, rect.origin.y, rect.size.width, rect.size.height]
}
function check(condition: boolean, message: string) { if (!condition) throw Error(message) }
function fits(widget: Gtk.Widget, window: Gtk.Widget) {
    const [x, , width] = bounds(widget, window)
    check(x >= -1 && x + width <= window.get_width() + 1,
        widget.get_css_classes().join(".") + " exceeds surface: " + [x, width, window.get_width()])
}
function measure(window: Gtk.Widget, count: number, hover_card: Gtk.Widget | null, expected_texture: Gdk.Texture | null) {
    const all = walk(window)
    const cards = all.filter(widget => widget.has_css_class("notification"))
    const scroll = all.find(widget => widget instanceof Gtk.ScrolledWindow) as Gtk.ScrolledWindow
    const stack = one(all, "notifications-stack")
    const surface = (window as Gtk.Window).get_surface()!
    const monitor = Gdk.Display.get_default().get_monitors().get_item(0).get_geometry()
    const width = Math.round(350 * scale_number / 100)
    check(monitor.width === 960 && monitor.height === 600, "not the private 960x600 output")
    check((window as any).anchor === (Astal.WindowAnchor.TOP | Astal.WindowAnchor.RIGHT), "not top-right anchored")
    check(surface.get_width() === width && surface.get_width() <= monitor.width, "wrong surface width")
    check(surface.get_height() <= monitor.height, "surface exceeds output height")
    check(cards.length === count, "notification count " + cards.length + " != " + count)
    check(stack.measure(Gtk.Orientation.HORIZONTAL, -1)[0] <= width + 1, "stack minimum exceeds surface")
    const horizontal = scroll.get_hadjustment()
    check(horizontal.get_upper() <= horizontal.get_page_size() + 1, "horizontal overflow " +
        [horizontal.get_upper(), horizontal.get_page_size()])
    for (const card of cards) {
        fits(card, window)
        const descendants = walk(card)
        const title = one(descendants, "summary") as Gtk.Label
        const text = one(descendants, "body") as Gtk.Label
        for (const item of [title, text]) {
            fits(item, window)
            check(item.get_wrap() && item.get_layout().get_line_count() > 1, "text did not wrap")
            check(item.get_layout().get_text() === item.get_label() && !item.get_layout().is_ellipsized(), "text truncated")
        }
        const preview = one(descendants, "preview") as Gtk.Picture
        check(preview.get_paintable() === expected_texture, "preview has the wrong paintable")
        const size = Math.round(75 * scale_number / 100)
        const expected_height = expected_texture ? Math.max(1, Math.round(expected_texture.get_height() *
            Math.min(size / expected_texture.get_width(), size / expected_texture.get_height()))) : size
        check(preview.height_request === expected_height,
            "preview fitted height did not update: " + [preview.height_request, expected_height])
        if (expected_texture) {
            check(preview.get_visible() && preview.get_width() > 0 && preview.get_height() > 0,
                "published preview is hidden or unallocated")
            fits(preview, window)
        } else {
            check(!preview.get_visible(), "preview visible before texture publishes")
        }
    }
    if (hover_card) {
        const descendants = walk(hover_card)
        const close = one(descendants, "close-button")
        check((close.get_parent() as Gtk.Revealer).get_reveal_child() && close.get_width() > 0,
            "close not revealed")
        fits(close, window)
        const actions = one(descendants, "actions")
        check(actions.get_width() > 0, "actions not revealed")
        fits(actions, window)
        const buttons = children(actions)
        check(buttons.length === 2, "two actions expected")
        for (const button of buttons) {
            fits(button, window)
            const label = children(button)[0] as Gtk.Label
            fits(label, window)
            check(label.get_layout().get_text() === label.get_label() && !label.get_layout().is_ellipsized(),
                "action truncated")
        }
        check((children(buttons[1])[0] as Gtk.Label).get_layout().get_line_count() > 1, "long action did not wrap")
    }
    return { cards, scroll }
}
const delay = (ms: number) => new Promise<void>(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE })
})
app.start({ instanceName: "private-notification-placement-" + scale_number, main() {
    app.apply_css(GLib.getenv("FIXTURE_CSS")!)
    const size = scale_number / 100
    app.apply_css("* { --bg: #171717; --fg: #eeeeee; --widget-bg: #303030; --hover-bg: #404040; " +
        "--border-color: #555555; --popover-border-color: #555555; --primary-bg: #51a4e7; " +
        "--primary-fg: #141414; --error-bg: #e55f86; --shadow-color: transparent; " +
        "--neu-widget-highlight: 0 0 0 0 transparent; --neu-widget-shadow: 0 0 0 0 transparent; " +
        "--neu-button-highlight: 0 0 0 0 transparent; --neu-button-shadow: 0 0 0 0 transparent; " +
        "--transition: 0ms; --font-name: sans; --font-size: " + Math.round(11 * size) + "pt; " +
        "--icon-size: " + Math.round(16 * size) + "px; --padding: " + 8 * size + "pt; " +
        "--spacing: " + 6 * size + "pt; --popover-padding: " + 12.8 * size + "pt; " +
        "--radius: " + 12 * size + "px; --popover-radius: " + 24 * size + "px; " +
        "--border-width: " + size + "px; }")
    items.push(synthetic(1))
    notification_manager.notifications = [...items]
    const window = Notifications.Window() as Gtk.Widget
    void (async () => {
        await delay(400)
        const { cards } = measure(window, 1, null, null)
        const first = cards[0]
        const first_motion = first.observe_controllers().get_item(0) as Gtk.EventControllerMotion
        first_motion.emit("enter", 0, 0)
        await delay(120)
        measure(window, 1, first, null)
        const bytes = new GLib.Bytes(new Uint8Array(600 * 100 * 4).fill(255))
        const published = Gdk.MemoryTexture.new(600, 100, Gdk.MemoryFormat.R8G8B8A8, bytes, 600 * 4)
        set_texture(published)
        await delay(120)
        measure(window, 1, first, published)
        for (let id = 2; id <= 8; id++) {
            items.push(synthetic(id))
            notification_daemon.emit("notified", id)
        }
        await delay(250)
        const { cards: full_cards, scroll } = measure(window, 8, null, published)
        const newest = full_cards[0]
        const newest_motion = newest.observe_controllers().get_item(0) as Gtk.EventControllerMotion
        newest_motion.emit("enter", 0, 0)
        await delay(120)
        measure(window, 8, newest, published)
        const last = full_cards[full_cards.length - 1]
        const last_motion = last.observe_controllers().get_item(0) as Gtk.EventControllerMotion
        last_motion.emit("enter", 0, 0)
        await delay(120)
        const vertical = scroll.get_vadjustment()
        check(vertical.get_upper() > vertical.get_page_size(), "tall stack cannot scroll")
        vertical.set_value(vertical.get_upper() - vertical.get_page_size())
        await delay(100)
        vertical.set_value(vertical.get_upper() - vertical.get_page_size())
        await delay(100)
        measure(window, 8, last, published)
        const [, y, , height] = bounds(last, window)
        const [, viewport_top, , viewport_height] = bounds(scroll, window)
        const viewport_bottom = viewport_top + viewport_height
        const actions = one(walk(last), "actions")
        const trailing = children(actions).at(-1)!
        const [, action_top, , action_height] = bounds(trailing, window)
        check(vertical.get_value() >= vertical.get_upper() - vertical.get_page_size() - 1,
            "vertical scroll did not reach its maximum: " +
            [vertical.get_value(), vertical.get_upper(), vertical.get_page_size()])
        check(y < viewport_bottom && y + height >= viewport_top - 1 &&
            y + height <= viewport_bottom + 2, "last card bottom not reachable: " +
            [y, height, viewport_top, viewport_bottom, vertical.get_value(), vertical.get_upper()])
        check(action_height > 0 && action_top >= viewport_top - 1 &&
            action_top + action_height <= viewport_bottom + 1, "last trailing action clipped by viewport")

        const removed_preview = one(walk(last), "preview") as Gtk.Picture
        const old_height = removed_preview.height_request
        items.splice(items.findIndex(item => item.id === 1), 1)
        notification_daemon.emit("resolved", 1)
        await delay(200)
        check(walk(window).filter(widget => widget.has_css_class("notification")).length === 7,
            "resolved notification was not removed")
        check(!last.get_parent()?.get_parent(), "resolved entry is still parented")
        const replacement_bytes = new GLib.Bytes(new Uint8Array(100 * 200 * 4).fill(255))
        const replacement = Gdk.MemoryTexture.new(100, 200, Gdk.MemoryFormat.R8G8B8A8, replacement_bytes, 100 * 4)
        set_texture(replacement)
        await delay(150)
        measure(window, 7, null, replacement)
        check(removed_preview.get_paintable() === published && removed_preview.height_request === old_height,
            "disposed preview still reacts to texture updates")
        for (const item of [...items]) {
            items.splice(items.indexOf(item), 1)
            notification_daemon.emit("resolved", item.id)
        }
        await delay(200)
        check(walk(window).every(widget => !widget.has_css_class("notification")),
            "resolved entries were not disposed")
        check(!(window as Gtk.Window).get_visible(), "empty notification surface remains visible")
        check(active_timers.size === 0, "entry timers survived disposal: " + active_timers.size)
        print("PLACEMENT_OK " + scale_number)
        app.quit()
    })().catch(error => { console.error("PLACEMENT_FAIL", error); app.quit(1) })
} })
`
