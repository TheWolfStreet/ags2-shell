import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { load_module } from "../load_module.ts"
import {
	accessor,
	create_state,
	create_binding,
	emitter,
	make_mutable as make,
	capture_timer,
	type fake_timer,
	capture_kinds,
	revealer_transitions,
} from "../helpers.ts"

test.afterEach(() => mock.restoreAll())

type fake_notification = {
	id: number
	time: number
	[key: string]: any
}

function find_all(tree, matches: (node) => boolean) {
	if (!tree || typeof tree !== "object") return []
	if (Array.isArray(tree))
		return tree.flatMap((node) => find_all(node, matches))
	const own = matches(tree) ? [tree] : []
	return [...own, ...tree.children.flatMap((node) => find_all(node, matches))]
}

function capture(method: "warn" | "error") {
	const calls: unknown[][] = []
	mock.method(console, method, (...args) => {
		if (String(args[0]).startsWith("notifications")) calls.push(args)
	})
	return calls
}

async function notifications_fixture({
	session_start = 0,
	notifications = [] as fake_notification[],
	position = "top-right",
	dismiss_ms = 3500,
	duration = 200,
	now = 100_000,
} = {}) {
	const timers: fake_timer[] = []
	const scopes: (() => void)[][] = [[]]
	const live = new Map<number, fake_notification>()
	const blacklisted = new Set<string>()
	const blacklist_listeners: (() => void)[] = []
	const dismissed: number[] = []
	const invoked: [number, string][] = []
	let dnd = false
	let current_position = position

	const timeout = capture_timer(timers)
	const daemon = Object.assign(emitter(), {
		get_notifications: () => [...live.values()],
		get_notification: (id) => live.get(id) ?? null,
	})
	const options = {
		transition: { duration: accessor(() => duration) },
		notifications: {
			position: accessor(() => current_position),
			dismiss: accessor(() => dismiss_ms),
			blacklist: {
				subscribe: (fn) => {
					blacklist_listeners.push(fn)
					return () => {}
				},
			},
		},
	}
	const ags = {
		createBinding: create_binding,
		createState: create_state,
		createComputed: accessor,
		createRoot: (fn) => {
			const scope: (() => void)[] = []
			scopes.push(scope)
			try {
				return fn(() => {
					for (const cleanup of scope.splice(0)) cleanup()
				})
			} finally {
				scopes.pop()
			}
		},
		onCleanup: (fn) => scopes.at(-1)!.push(fn),
	}
	const lifecycle = await load_module(
		"widget/Bar/components/Notifications/entry_lifecycle.ts",
		{
			ags,
			"$lib/time": { timeout },
			"gi://AstalNotifd": { default: {} },
			"$lib/notifications": { notification_daemon: daemon },
			"$shell/options": { default: options },
		},
	)
	const { Notifications } = await load_module(
		"widget/Bar/components/Notifications/index.tsx",
		{
			ags,
			"ags/gtk4": {
				Astal: {
					Exclusivity: { NORMAL: 1 },
					WindowAnchor: { TOP: 1, BOTTOM: 2, LEFT: 4, RIGHT: 8 },
				},
				Gdk: {},
				Gtk: {
					Picture: "picture",
					Align: { START: 1, CENTER: 2, END: 3 },
					Orientation: { VERTICAL: 1, HORIZONTAL: 2 },
					PolicyType: { AUTOMATIC: 1, EXTERNAL: 3 },
					RevealerTransitionType: revealer_transitions,
					EventControllerMotion: "motion",
				},
			},
			"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
			"$lib/app": { default: {} },
			"ags/time": { createPoll: () => (transform) => accessor(transform) },
			"$lib/time": { timeout },
			"gi://AstalNotifd": { default: { Urgency: { LOW: 0, CRITICAL: 2 } } },
			"gi://GLib": {
				default: {
					get_user_cache_dir: () => "/home/user/.cache",
					DateTime: {
						new_now_local: () => ({ to_unix: () => now }),
						new_from_unix_local: (time) =>
							time < 0 ? null : { to_unix: () => time },
					},
				},
			},
			"gi://Pango": {
				default: { EllipsizeMode: { END: 1 }, WrapMode: { WORD_CHAR: 2 } },
			},
			"../PanelButton": { PanelButton: (props) => make("panel-button", props) },
			"$lib/env": { default: { paths: { home: "/home/user" } } },
			"$service/screen_capture": { capture_kinds },
			"$lib/textures": {
				classify_image_uri: (uri) => (uri.startsWith("/") ? "file" : "unknown"),
				create_texture_accessor: () => accessor(() => null),
			},
			"$lib/notifications": {
				notification_daemon: daemon,
				notification_action_available: () => true,
			},
			"$service/notifications": {
				notification_manager: {
					notifications: [],
					session_start,
					get do_not_disturb() {
						return dnd
					},
					is_blacklisted: (notification) =>
						blacklisted.has(notification.app_name),
				},
			},
			"./entry_lifecycle": lifecycle,
			"$shell/options": {
				scaled: (px) => accessor(() => px),
				default: options,
			},
		},
	)

	const notification = (id: number, time: number, extra = {}) => {
		const item: fake_notification = {
			id,
			time,
			urgency: 1,
			app_name: "App",
			summary: `summary ${id}`,
			body: `body ${id}`,
			resident: false,
			get_actions: () => [],
			get_image: () => "",
			get_app_icon: () => "",
			get_app_name: () => item.app_name,
			get_desktop_entry: () => "",
			get_category: () => "",
			dismiss: () => dismissed.push(item.id),
			invoke: (action) => invoked.push([item.id, action]),
			...extra,
		}
		return item
	}
	for (const item of notifications)
		live.set(item.id, notification(item.id, item.time, item))

	return {
		Notifications,
		timers,
		dismissed,
		invoked,
		live,
		notification,
		add(item: fake_notification) {
			live.set(item.id, item)
			daemon.emit("notified", item.id)
		},
		resolve(id: number) {
			live.delete(id)
			daemon.emit("resolved", id, 1)
		},
		set_dnd: (value: boolean) => {
			dnd = value
		},
		set_position: (value: string) => {
			current_position = value
		},
		blacklist(name: string) {
			blacklisted.add(name)
			for (const listener of blacklist_listeners) listener()
		},
		listener_count: () => daemon.listeners.size,
		pending: () => timers.filter((timer) => !timer.cancelled),
		fire(timer: fake_timer) {
			timer.cancelled = true
			timer.callback()
		},
		cleanup: () => {
			for (const cleanup of scopes[0].splice(0)) cleanup()
		},
	}
}

function summaries(list) {
	return list.children.map(
		(row) =>
			find_all(row, (node) => node.props.class === "summary")[0].props.label,
	)
}

test("popup list shows session notifications newest first and reports counts", async () => {
	const f = await notifications_fixture({
		session_start: 4,
		notifications: [
			{ id: 1, time: 5 },
			{ id: 2, time: 3 },
			{ id: 3, time: 8 },
		],
	})
	const counts: number[] = []
	const list = f.Notifications.NotificationList({
		class: "stack",
		persistent: false,
		on_count_changed: (count) => counts.push(count),
	})
	assert.equal(list.props.class, "stack")
	assert.deepEqual(summaries(list), ["summary 3", "summary 1"])
	f.add(f.notification(4, 6))
	assert.deepEqual(summaries(list), ["summary 3", "summary 4", "summary 1"])
	f.add(f.notification(5, 8))
	assert.deepEqual(summaries(list), [
		"summary 5",
		"summary 3",
		"summary 4",
		"summary 1",
	])
	assert.deepEqual(counts, [1, 2, 3, 4])
	f.cleanup()
	assert.deepEqual(counts, [1, 2, 3, 4, 0])
	assert.equal(f.listener_count(), 0)
	assert.deepEqual(list.children, [])
})

test("mapped popups reveal, auto hide after the dismiss delay and exit after the transition", async () => {
	const f = await notifications_fixture({ dismiss_ms: 1234, duration: 30 })
	const counts: number[] = []
	const list = f.Notifications.NotificationList({
		class: "stack",
		persistent: false,
		on_count_changed: (count) => counts.push(count),
	})
	f.add(f.notification(1, 1))
	const [revealer] = list.children
	assert.equal(revealer.props.revealChild(), false)
	revealer.props.onMap()
	assert.equal(revealer.props.revealChild(), true)
	assert.deepEqual(
		f.pending().map((timer) => timer.ms),
		[1234],
	)
	const motion = find_all(revealer, (node) => node.type === "motion")[0]
	motion.props.onEnter()
	assert.deepEqual(f.pending(), [])
	motion.props.onLeave()
	assert.deepEqual(
		f.pending().map((timer) => timer.ms),
		[1234],
	)
	f.fire(f.pending()[0])
	assert.equal(revealer.props.revealChild(), false)
	assert.deepEqual(
		f.pending().map((timer) => timer.ms),
		[100],
	)
	revealer.props.onNotifyChildRevealed({ get_child_revealed: () => false })
	assert.deepEqual(list.children, [])
	assert.deepEqual(counts, [1, 0])
	assert.deepEqual(f.pending(), [])
	f.cleanup()
})

test("the exit timer uses twice the transition and removes the entry", async () => {
	const f = await notifications_fixture({ duration: 400 })
	const list = f.Notifications.NotificationList({
		class: "stack",
		persistent: false,
	})
	f.add(f.notification(1, 1))
	list.children[0].props.onMap()
	f.fire(f.pending()[0])
	const [exit] = f.pending()
	assert.equal(exit.ms, 800)
	f.fire(exit)
	assert.deepEqual(list.children, [])
	f.cleanup()
})

test("a replaced notification closes the old row and mounts the new object after it exits", async () => {
	const f = await notifications_fixture()
	const list = f.Notifications.NotificationList({
		class: "stack",
		persistent: false,
	})
	f.add(f.notification(1, 1))
	f.add(f.notification(2, 2))
	for (const row of list.children) row.props.onMap()
	const replacement = f.notification(1, 3, { summary: "replaced" })
	f.add(replacement)
	assert.deepEqual(summaries(list), ["summary 2", "summary 1"])
	assert.equal(list.children[1].props.revealChild(), false)
	list.children[1].props.onNotifyChildRevealed({
		get_child_revealed: () => false,
	})
	assert.deepEqual(summaries(list), ["replaced", "summary 2"])
	f.cleanup()
})

test("a replacement that is itself replaced before the exit is skipped", async () => {
	const f = await notifications_fixture()
	const list = f.Notifications.NotificationList({
		class: "stack",
		persistent: false,
	})
	f.add(f.notification(1, 1))
	list.children[0].props.onMap()
	f.add(f.notification(1, 2, { summary: "first" }))
	f.live.set(1, f.notification(1, 3, { summary: "second" }))
	list.children[0].props.onNotifyChildRevealed({
		get_child_revealed: () => false,
	})
	assert.deepEqual(summaries(list), [])
	f.cleanup()
})

test("resolving an unmapped popup removes it at once and unknown ids are ignored", async () => {
	const f = await notifications_fixture()
	const counts: number[] = []
	const list = f.Notifications.NotificationList({
		class: "stack",
		persistent: false,
		on_count_changed: (count) => counts.push(count),
	})
	f.add(f.notification(1, 1))
	f.resolve(99)
	f.resolve(1)
	assert.deepEqual(list.children, [])
	assert.deepEqual(counts, [1, 0])
	f.cleanup()
})

test("do not disturb blocks new popups but not history", async () => {
	const f = await notifications_fixture()
	const popup = f.Notifications.NotificationList({
		class: "stack",
		persistent: false,
	})
	const history = f.Notifications.NotificationList({
		class: "history",
		persistent: true,
	})
	f.set_dnd(true)
	f.add(f.notification(1, 1))
	assert.deepEqual(summaries(popup), [])
	assert.deepEqual(summaries(history), ["summary 1"])
	f.cleanup()
})

test("blacklisting closes matching rows and history reconciles to the newest fifty", async () => {
	const f = await notifications_fixture({
		notifications: Array.from({ length: 52 }, (_value, index) => ({
			id: index + 1,
			time: index + 1,
		})),
	})
	const history = f.Notifications.NotificationList({
		class: "history",
		persistent: true,
	})
	assert.equal(history.children.length, 50)
	assert.equal(summaries(history)[0], "summary 52")
	assert.equal(summaries(history)[49], "summary 3")
	f.add(f.notification(60, 60, { app_name: "Noise" }))
	assert.equal(history.children.length, 50)
	assert.equal(summaries(history)[0], "summary 60")
	assert.equal(summaries(history)[49], "summary 4")
	f.blacklist("Noise")
	assert.equal(summaries(history)[0], "summary 52")
	assert.equal(history.children.length, 50)
	assert.equal(summaries(history)[49], "summary 3")
	f.cleanup()
})

test("history refills from the backlog when a shown entry exits", async () => {
	const f = await notifications_fixture({
		notifications: Array.from({ length: 51 }, (_value, index) => ({
			id: index + 1,
			time: index + 1,
		})),
	})
	const history = f.Notifications.NotificationList({
		class: "history",
		persistent: true,
	})
	assert.equal(summaries(history).at(-1), "summary 2")
	f.resolve(51)
	assert.equal(history.children.length, 50)
	assert.equal(summaries(history).at(-1), "summary 1")
	f.cleanup()
})

test("a pending replacement is dropped when it stops being accepted", async () => {
	const f = await notifications_fixture()
	const list = f.Notifications.NotificationList({
		class: "stack",
		persistent: false,
	})
	f.add(f.notification(1, 1))
	list.children[0].props.onMap()
	const replacement = f.notification(1, 2, { summary: "replaced" })
	f.add(replacement)
	f.set_dnd(true)
	f.add(replacement)
	f.set_dnd(false)
	list.children[0].props.onNotifyChildRevealed({
		get_child_revealed: () => false,
	})
	assert.deepEqual(summaries(list), [])
	f.cleanup()
})

test("history reconciles after a resolved entry exits", async () => {
	const f = await notifications_fixture({
		notifications: [
			{ id: 1, time: 1 },
			{ id: 2, time: 2 },
		],
	})
	const history = f.Notifications.NotificationList({
		class: "history",
		persistent: true,
	})
	for (const row of history.children) row.props.onMap()
	f.resolve(2)
	assert.deepEqual(summaries(history), ["summary 2", "summary 1"])
	history.children[0].props.onNotifyChildRevealed({
		get_child_revealed: () => false,
	})
	assert.deepEqual(summaries(history), ["summary 1"])
	f.live.set(3, f.notification(3, 3))
	f.resolve(42)
	assert.deepEqual(summaries(history), ["summary 3", "summary 1"])
	f.cleanup()
})

test("actions invoke only the live notification and close unless resident in history", async () => {
	const f = await notifications_fixture()
	const errors = capture("error")
	const actions = [{ id: "open", label: "Open" }]
	const popup = f.Notifications.NotificationList({
		class: "stack",
		persistent: false,
	})
	const history = f.Notifications.NotificationList({
		class: "history",
		persistent: true,
	})
	f.add(f.notification(1, 1, { resident: true, get_actions: () => actions }))
	for (const row of [...popup.children, ...history.children]) row.props.onMap()
	const button = (list) =>
		find_all(list, (node) => node.type === "button" && !node.props.class)[0]
	button(history).props.onClicked()
	assert.deepEqual(f.invoked, [[1, "open"]])
	assert.equal(history.children[0].props.revealChild(), true)
	button(popup).props.onClicked()
	assert.deepEqual(f.invoked, [
		[1, "open"],
		[1, "open"],
	])
	assert.equal(popup.children[0].props.revealChild(), false)
	f.live.get(1)!.invoke = () => {
		throw new Error("gone")
	}
	button(history).props.onClicked()
	assert.equal(errors.length, 1)
	assert.equal(
		errors[0][0],
		"notifications.action: Failed to invoke notification action",
	)
	f.live.set(1, f.notification(1, 1))
	button(history).props.onClicked()
	assert.equal(errors.length, 1)
	f.cleanup()
})

test("the close button dismisses only the live notification and always closes", async () => {
	const f = await notifications_fixture()
	const list = f.Notifications.NotificationList({
		class: "history",
		persistent: true,
	})
	f.add(f.notification(1, 1))
	f.add(f.notification(2, 2))
	for (const row of list.children) row.props.onMap()
	const close = (row) =>
		find_all(row, (node) => node.props.class === "close-button")[0]
	f.live.set(1, f.notification(1, 1))
	close(list.children[1]).props.onClicked()
	close(list.children[0]).props.onClicked()
	assert.deepEqual(f.dismissed, [2])
	assert.deepEqual(
		list.children.map((row) => row.props.revealChild()),
		[false, false],
	)
	f.cleanup()
})

test("dismiss all walks newest first every fifty milliseconds and skips replaced objects", async () => {
	const f = await notifications_fixture({
		notifications: [
			{ id: 1, time: 1 },
			{ id: 2, time: 3 },
			{ id: 3, time: 2 },
		],
	})
	mock.method(Math, "random", () => 0.25)
	f.Notifications.animate_dismiss_all()
	assert.deepEqual(
		f.pending().map((timer) => timer.ms),
		[25],
	)
	f.fire(f.pending()[0])
	assert.deepEqual(
		f.pending().map((timer) => timer.ms),
		[50],
	)
	f.live.set(3, f.notification(3, 2))
	f.fire(f.pending()[0])
	assert.deepEqual(
		f.pending().map((timer) => timer.ms),
		[50],
	)
	f.fire(f.pending()[0])
	assert.deepEqual(f.pending(), [])
	assert.deepEqual(f.dismissed, [2, 1])
})

test("dismiss all with nothing pending schedules nothing", async () => {
	const f = await notifications_fixture()
	f.Notifications.animate_dismiss_all()
	assert.deepEqual(f.timers, [])
})

test("the popup window anchors and slides from the configured corner", async () => {
	const expected = {
		"top-left": [5, 1],
		"top-center": [1, 1],
		"top-right": [9, 1],
		"bottom-left": [6, 2],
		"bottom-center": [2, 2],
		"bottom-right": [10, 2],
	}
	for (const [position, [anchor, transition]] of Object.entries(expected)) {
		const f = await notifications_fixture({ position })
		const window = f.Notifications.Window()
		assert.equal(window.props.anchor(), anchor, position)
		const list = window.children[0].children[0]
		f.add(f.notification(1, 1))
		assert.equal(list.children[0].props.transitionType(), transition, position)
		assert.equal(window.props.visible(), true)
		f.cleanup()
	}
	const f = await notifications_fixture()
	const window = f.Notifications.Window()
	assert.equal(window.props.visible(), false)
	f.set_position("bottom-left")
	assert.equal(window.props.anchor(), 6)
	f.cleanup()
})

test("headers name the app, pick an icon and show a relative time", async () => {
	const f = await notifications_fixture({ now: 100_000 })
	const list = f.Notifications.NotificationList({
		class: "history",
		persistent: true,
	})
	const cases = [
		[{ time: 99_990 }, "APP", "dialog-information-symbolic", "now"],
		[
			{ time: 99_000, get_app_icon: () => "audio-card-analog" },
			"APP",
			"audio-card-symbolic",
			"16m ago",
		],
		[
			{
				time: 90_000,
				app_name: "",
				get_desktop_entry: () => "org.app",
			},
			"ORG.APP",
			"org.app",
			"2h ago",
		],
		[
			{ time: 1_000, app_name: "", get_image: () => "image-name" },
			"NOTIFICATION",
			"image-name",
			"1d ago",
		],
		[
			{ time: -5, get_image: () => "/tmp/picture.png" },
			"APP",
			"dialog-information-symbolic",
			"",
		],
	] as const
	for (const [index, [extra, name, icon, time]] of cases.entries()) {
		f.add(f.notification(index + 1, 0, extra))
		const header = find_all(
			list.children.find(
				(row) =>
					find_all(row, (node) => node.props.label === `summary ${index + 1}`)
						.length,
			),
			(node) => node.props.class === "header",
		)[0]
		const [app_icon, app_name, clock] = header.children
		assert.equal(app_name.props.label, name)
		assert.equal(app_icon.props.iconName, icon)
		assert.equal(clock.props.label(), time)
	}
	f.cleanup()
})

test("bodies drop markup, keep image alt text and decode entities safely", async () => {
	const f = await notifications_fixture()
	const list = f.Notifications.NotificationList({
		class: "history",
		persistent: true,
	})
	const cases = [
		[
			"<b>Bold</b> &amp; &lt;tag&gt; &quot;q&quot; &apos;a&apos;",
			`Bold & <tag> "q" 'a'`,
		],
		["one<br>two<br/>three<BR />four", "one\ntwo\nthree\nfour"],
		[`<img src="x" alt="cat"> <img alt='dog' /> <img src=y>`, "cat dog "],
		["&#65;&#x42;&#X43;&#9;&#10;&#13;", "ABC\t\n\r"],
		["&#0;&#x1F;&#1114112;&#x110000;", "����"],
		["&#128512; &unknown; &amp", "😀 &unknown; &amp"],
		["<a href='x'>link</a>", "link"],
		["<i></i>", ""],
	]
	for (const [index, [body]] of cases.entries())
		f.add(f.notification(index + 1, index + 1, { body }))
	for (const [index, [, expected]] of cases.entries()) {
		const row = list.children.find(
			(candidate) =>
				find_all(
					candidate,
					(node) => node.props.label === `summary ${index + 1}`,
				).length,
		)
		const body = find_all(row, (node) => node.props.class === "body")[0]
		assert.equal(body?.props.label ?? "", expected, cases[index][0])
	}
	f.cleanup()
})
