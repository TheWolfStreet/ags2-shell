import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")

async function render_notification(persistent, actions, details = {}) {
	const accessor = get => Object.assign(() => get(), { peek: get, as: fn => accessor(() => fn(get())) })
	const node = (type, props = {}) => ({ type, props,
		children: (Array.isArray(props.children) ? props.children : [props.children]).filter(Boolean),
		insert_child_after(child, previous) {
			this.children.splice(previous ? this.children.indexOf(previous) + 1 : 0, 0, child)
		},
		remove(child) { this.children.splice(this.children.indexOf(child), 1) },
	})
	const jsx = (type, props) => typeof type === "function" ? type(props) : node(type, props)
	let dnd = false
	let closes = 0
	let mounted = 0
	const live_keys = new Set(["ags2-shell:live"])
	const clicks = []
	const notification = {
		id: 7, time: 1, urgency: 1, body: "First line\nSaved to /home/user/Pictures/very-long-full-original-name.png",
		summary: "Screenshot with a full descriptive summary", resident: true,
		get_actions: () => actions, get_image: () => details.image ?? "", get_app_icon: () => "",
		get_app_name: () => details.app_name ?? "Capture", get_desktop_entry: () => "",
		...details.notification,
	}
	let incoming = notification
	const listeners = new Map()
	let next = 0
	const daemon = {
		get_notifications: () => incoming === notification ? [notification] : [notification, incoming],
		get_notification: id => id === incoming.id ? incoming : notification,
		connect: (event, fn) => { listeners.set(++next, { event, fn }); return next },
		disconnect: id => listeners.delete(id),
		emit: (event, ...args) => { for (const listener of listeners.values())
			if (listener.event === event) listener.fn(daemon, ...args) },
	}
	const options = { scale: accessor(() => 100), transition: { duration: 0 },
		notifications: { position: accessor(() => "top-right"), blacklist: { subscribe: () => () => {} } } }
	const imports = {
		ags: {
			createBinding: (object, property) => accessor(() => object[property]),
			createState: initial => { let value = initial; return [accessor(() => value), next => { value = next }] },
			createComputed: fn => accessor(fn), createRoot: fn => fn(() => {}), onCleanup: () => {},
		},
		"ags/gtk4": { Astal: { Exclusivity: { NORMAL: 1 }, WindowAnchor: {} }, Gdk: {},
			Gtk: { Picture: "picture", Align: { START: 1, CENTER: 2, END: 3 },
				Orientation: { VERTICAL: 1, HORIZONTAL: 2 }, WrapMode: { WORD_CHAR: 1 },
				RevealerTransitionType: { SLIDE_DOWN: 1, SLIDE_UP: 2, SWING_RIGHT: 3, SWING_DOWN: 4 },
				EventControllerMotion: "motion" } },
		"ags/gtk4/jsx-runtime": { jsx, jsxs: jsx },
		"$lib/app": { default: {} }, "ags/time": { createPoll: (_n, _ms, fn) => fn },
		"$lib/time": { timeout: () => ({ cancel() {} }) },
		"gi://AstalNotifd": { default: { Urgency: { LOW: 0, CRITICAL: 2 } } },
		"gi://GLib": { default: { DateTime: { new_now_local: () => ({ to_unix: () => 10 }),
			new_from_unix_local: time => ({ to_unix: () => time }) } } },
		"gi://Pango": { default: { EllipsizeMode: { END: 1, NONE: 0 } } },
		"../PanelButton": { PanelButton: props => node("panel-button", props) },
		"$lib/icons": { default: { notifications: { message: "message" }, fallback: { notification: "fallback" }, ui: { close: "close" } },
			substitute_icon_name: name => name },
		"$lib/env": { default: { paths: { home: "/home/user" } } },
		"$lib/textures": { classify_image_uri: () => "file", create_texture_accessor: () => accessor(() => null) },
		"$lib/notifications": { notification_daemon: daemon,
			notification_action_available: key => !key.startsWith("ags2-shell:") || live_keys.has(key) },
		"$service/notifications": { notification_manager: { notifications: [notification], session_start: details.session_start ?? 0,
			get do_not_disturb() { return dnd }, is_blacklisted: () => false } },
		"./EntryLifecycle": { create_entry_lifecycle: () => { mounted++; return { visible: accessor(() => true),
			is_closing: () => false, close: () => { closes++ }, cleanup: () => {},
			keep_alive: () => {}, resume: () => {}, dismiss: () => {}, on_action_click: id => clicks.push(id),
			on_map: () => {}, on_revealed_changed: () => {} } } },
		"$shell/options": { default: options },
	}
	const source = readFileSync(new URL("../../widget/Bar/components/Notifications/index.tsx", import.meta.url), "utf8")
	const compiled = ts.transpileModule(source, { compilerOptions: {
		module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
		jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "ags/gtk4",
	} }).outputText
	const module = new SourceTextModule(compiled)
	await module.link(name => {
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name])) this.setExport(key, value)
		})
	})
	await module.evaluate()
	const root = persistent ? module.namespace.Notifications.Stack({ class: "history" }) : module.namespace.Notifications.Window()
	const visit = item => !item ? [] : Array.isArray(item) ? item.flatMap(visit) :
		typeof item !== "object" ? [] : [item, ...item.children.flatMap(visit)]
	return { nodes: visit(root), set_dnd: value => { dnd = value; daemon.emit("notify::dont-disturb") },
		notify_new: () => { incoming = { ...notification, id: 8 }; daemon.emit("notified", 8) },
		closed: () => closes, mounted: () => mounted, live_keys, clicks }
}

function action_revealer(view) {
	return view.nodes.find(item => item.type === "revealer" &&
		item.children.some(child => child.props.class === "actions horizontal"))
}

test("history preserves complete text and hides expired own actions without hiding external actions", async () => {
	const view = await render_notification(true, [
		{ id: "ags2-shell:expired", label: "Dead" },
		{ id: "ags2-shell:live", label: "Open" },
		{ id: "external-id", label: "External" },
	])
	const summary = view.nodes.find(item => item.props.class === "summary")
	const body = view.nodes.find(item => item.props.class === "body")
	assert.equal(summary.props.lines, undefined)
	assert.equal(body.props.lines, undefined)
	assert.equal(summary.props.label, "Screenshot with a full descriptive summary")
	assert.equal(body.props.label, "First line\nSaved to /home/user/Pictures/very-long-full-original-name.png")
	assert.deepEqual(view.nodes.filter(item => item.type === "button" && item.props.label && item.props.visible())
		.map(item => item.props.label), ["Open", "External"])
	const expired = view.nodes.find(item => item.type === "button" && item.props.label === "Dead")
	assert.equal(expired.props.visible(), false)
	expired.props.onClicked()
	assert.deepEqual(view.clicks, [])
	const live = view.nodes.find(item => item.type === "button" && item.props.label === "Open")
	view.live_keys.delete("ags2-shell:live")
	assert.equal(live.props.visible(), false)
	live.props.onClicked()
	assert.deepEqual(view.clicks, [])
	view.live_keys.add("ags2-shell:live")
	assert.equal(live.props.visible(), true)
	live.props.onClicked()
	assert.deepEqual(view.clicks, ["ags2-shell:live"])
})

test("DND blocks new popups but does not close an already displayed popup", async () => {
	const view = await render_notification(false, [{ id: "external-id", label: "External" }])
	assert.equal(view.nodes.find(item => item.props.class === "body").props.lines, undefined)
	view.set_dnd(true)
	assert.equal(view.closed(), 0)
	view.notify_new()
	assert.equal(view.mounted(), 1)
})

test("archived legacy captures retain their descriptors but never offer stale UUID or command actions", async () => {
	const screenshot_path = "/home/user/Pictures/Screenshots/2026-09-29_12-30-00.png"
	const screenshot = await render_notification(true, [
		{ id: "4b23432a-46c1-4d96-a783-48e74891c456", label: "View" },
		{ id: "xdg-open '/home/user/Pictures/Screenshots/'", label: "Show in Files" },
	], { app_name: "Screenshot", image: screenshot_path, session_start: 100,
		notification: { summary: "Screenshot taken", body: screenshot_path } })
	assert.equal(screenshot.nodes.find(item => item.props.class === "body").props.label, screenshot_path)
	assert.equal(screenshot.nodes.find(item => item.type === "picture").props.tooltipText, screenshot_path)
	assert.equal(action_revealer(screenshot), undefined)
	assert.equal(screenshot.nodes.some(item => item.type === "button" && item.props.label), false)
	const concise = await render_notification(true, [
		{ id: "old-uuid", label: "View" },
	], { app_name: "Screenshot", image: screenshot_path, session_start: 100,
		notification: { summary: "Screenshot taken", body: "Saved to Pictures/Screenshots" } })
	assert.equal(concise.nodes.find(item => item.props.class === "body").props.label, "Saved to Pictures/Screenshots")
	assert.equal(action_revealer(concise), undefined)

	const recording_path = "/home/user/Videos/Screencasting/2026-09-29_12-30-00.mkv"
	const recording = await render_notification(true, [
		{ id: `xdg-open '${recording_path}'`, label: "View" },
	], { app_name: "Recorder", session_start: 100,
		notification: { summary: "Recording saved", body: recording_path } })
	assert.equal(recording.nodes.find(item => item.props.class === "body").props.label, recording_path)
	assert.equal(action_revealer(recording), undefined)
})

test("external actions and current capture actions remain available", async () => {
	const path = "/home/user/Pictures/Screenshots/current.png"
	const actions = [{ id: "foreign-app-key", label: "View" }]
	const external = await render_notification(true, actions, { app_name: "Other App", image: path,
		session_start: 100, notification: { summary: "Screenshot taken", body: path } })
	assert.equal(external.nodes.find(item => item.type === "button" && item.props.label === "View").props.visible(), true)
	const other_path = await render_notification(true, actions, { app_name: "Screenshot", session_start: 100,
		notification: { summary: "Screenshot taken", body: "/elsewhere/current.png" } })
	assert.ok(action_revealer(other_path))
	const current = await render_notification(true, actions, { app_name: "Screenshot", image: path,
		session_start: 1, notification: { summary: "Screenshot taken", body: path } })
	assert.ok(action_revealer(current))
})

test("the action row closes after its last live binding expires while hovered", async () => {
	const view = await render_notification(true, [{ id: "ags2-shell:live", label: "View" }])
	const motion = view.nodes.find(item => item.type === "motion")
	const row = action_revealer(view)
	motion.props.onEnter()
	assert.equal(row.props.revealChild(), true)
	view.live_keys.delete("ags2-shell:live")
	assert.equal(row.props.revealChild(), false)
	view.live_keys.add("ags2-shell:live")
	assert.equal(row.props.revealChild(), true)
})
