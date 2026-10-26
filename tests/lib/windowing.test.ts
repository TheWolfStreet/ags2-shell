import assert from "node:assert/strict"
import { test } from "node:test"
import { with_hyprland_command } from "../hyprland.ts"
import { load_module } from "../load_module.ts"
import { accessor, create_state } from "../helpers.ts"

type listener = { event: string; callback: (...args: unknown[]) => void }

function emitter<T extends object>(fields: T) {
	let next = 1
	const listeners = new Map<number, listener>()
	return Object.assign(fields, {
		listeners,
		connect(event: string, callback: (...args: unknown[]) => void) {
			const id = next++
			listeners.set(id, { event, callback })
			return id
		},
		disconnect(id: number) {
			assert.ok(listeners.delete(id))
		},
		emit(event: string, ...args: unknown[]) {
			for (const entry of [...listeners.values()])
				if (entry.event === event) entry.callback(fields, ...args)
		},
	})
}

async function load_windowing() {
	const app = emitter({ windows: new Map<string, any>() })
	const hyprland = emitter({
		monitors: [] as any[],
		clients: [] as any[],
		focusedClient: null,
		focusedWorkspace: null as { id: number } | null,
		messages: [] as string[],
		reply: "ok",
		async message_async(message: string) {
			this.messages.push(message)
			return this.reply
		},
	})
	const cleanups: (() => void)[] = []
	const module = await load_module("lib/windowing.ts", {
		ags: {
			createBinding: (object: any, property: string) =>
				accessor(() => object[property]),
			createComputed: (compute: () => unknown) => accessor(compute),
			createMemo: (compute: () => unknown) => accessor(compute),
			createState: create_state,
			onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
		},
		"ags/gtk4": {
			Gdk: { BUTTON_PRIMARY: 1, BUTTON_MIDDLE: 2, BUTTON_SECONDARY: 3 },
			Gtk: {},
		},
		"$lib/app": { default: app },
		"$lib/time": { idle: (callback: () => void) => callback() },
		"gi://AstalHyprland": { default: { Fullscreen: { FULLSCREEN: 2 } } },
		cairo: { default: { Region: class {} } },
		"$lib/hyprland": with_hyprland_command({ hyprland }),
	})
	return { module, app, hyprland, cleanups }
}

function client(fields: Record<string, unknown>): Record<string, any> {
	return {
		class: "app",
		title: "Title",
		mapped: true,
		hidden: false,
		fullscreen: 0,
		fullscreenClient: 0,
		...fields,
	}
}

test("placement tracking connects once, bumps its version and reconnects after shutdown", async () => {
	const { module, app, hyprland } = await load_windowing()
	assert.equal(hyprland.listeners.size, 0)
	module.create_workspace_clients(1)
	module.create_workspace_clients(2)
	module.create_window_client_list(accessor(() => false))
	assert.deepEqual(
		[...hyprland.listeners.values()].map((entry) => entry.event),
		["client-moved", "client-added", "client-removed"],
	)
	let notified = 0
	module.client_placement_version.subscribe(() => notified++)
	const version = module.client_placement_version()
	hyprland.emit("client-moved")
	hyprland.emit("client-added")
	module.refresh_client_placement()
	assert.equal(module.client_placement_version(), version + 3)
	assert.equal(notified, 3)
	assert.equal(hyprland.listeners.size, 3)
	app.emit("shutdown")
	assert.equal(hyprland.listeners.size, 0)
	module.refresh_client_placement()
	assert.equal(hyprland.listeners.size, 3)
	module.create_workspace_clients(1)
	assert.equal(hyprland.listeners.size, 3)
})

test("client lists keep titled or classed clients, sorted and filtered by workspace", async () => {
	const { module, hyprland } = await load_windowing()
	const late = client({ address: "a", workspace: { id: 3 } })
	const early = client({ address: "b", workspace: { id: 1 } })
	const untitled = client({ class: "", title: "", workspace: { id: 1 } })
	const titled = client({
		class: "",
		title: "",
		get_title: () => "Named",
		workspace: { id: 1 },
	})
	const nowhere = client({
		address: "c",
		workspace: null,
		get_workspace: () => ({ id: 3 }),
	})
	const wine_menu = client({
		class: "steam_proton",
		title: "",
		xwayland: true,
		floating: true,
		workspace: { id: 1 },
	})
	const untitled_wayland = client({
		address: "d",
		title: "",
		floating: true,
		workspace: { id: 1 },
	})
	hyprland.clients = [late, null, early, untitled, titled, nowhere, wine_menu]
	assert.deepEqual(module.create_workspace_clients(3)(), [late, nowhere])
	assert.deepEqual(module.create_workspace_clients(1)(), [early, titled])
	const presenter = client({
		class: "org.kde.kdeconnect.daemon",
		title: "KDE Connect Daemon",
		workspace: { id: 1 },
	})
	hyprland.clients = [early, untitled_wayland, wine_menu, presenter]
	assert.deepEqual(module.create_workspace_clients(1)(), [
		early,
		untitled_wayland,
	])
	hyprland.clients = [late, null, early, untitled, titled, nowhere, wine_menu]
	const [exclusive, set_exclusive] = create_state(false)
	const list = module.create_window_client_list(exclusive)
	assert.deepEqual(list(), [early, titled, late, nowhere])
	set_exclusive(true)
	assert.deepEqual(list(), [early, titled, late, nowhere])
	hyprland.focusedWorkspace = { id: 3 }
	assert.deepEqual(list(), [late, nowhere])
	assert.equal(module.get_client_workspace_id(client({})), null)
})

test("monitor fullscreen follows the special workspace, then the active one", async () => {
	const { module, hyprland, cleanups } = await load_windowing()
	const target = {
		get_connector: () => "DP-1",
		get_geometry: () => ({ x: 100, y: 0 }),
	}
	const monitor = {
		id: 4,
		name: "DP-1",
		x: 100,
		y: 0,
		specialWorkspace: { id: 0 },
		activeWorkspace: { id: 2 },
	}
	const fullscreen = module.track_monitor_fullscreen(target)
	assert.equal(fullscreen(), false)
	hyprland.monitors = [monitor]
	const window = client({
		monitor: { id: 4 },
		workspace: { id: 2 },
		fullscreen: 2,
	})
	hyprland.clients = [window]
	hyprland.emit("event")
	assert.equal(fullscreen(), true)
	monitor.specialWorkspace = { id: -98 }
	hyprland.emit("event")
	assert.equal(fullscreen(), false)
	window.workspace = { id: -98 }
	hyprland.emit("event")
	assert.equal(fullscreen(), true)
	window.fullscreen = 0
	hyprland.emit("event")
	assert.equal(fullscreen(), false)
	window.fullscreenClient = 2
	hyprland.emit("event")
	assert.equal(fullscreen(), true)
	window.hidden = true
	hyprland.emit("event")
	assert.equal(fullscreen(), false)
	window.hidden = false
	monitor.name = "HDMI-A-1"
	hyprland.emit("event")
	assert.equal(fullscreen(), true)
	monitor.x = 0
	hyprland.emit("event")
	assert.equal(fullscreen(), false)
	assert.equal(cleanups.length, 1)
	cleanups[0]()
	assert.equal(hyprland.listeners.size, 0)
})

test("client dispatches quote the address and report failures with their tag", async (t) => {
	const { module, hyprland } = await load_windowing()
	const logged: unknown[][] = []
	t.mock.method(console, "error", (...args: unknown[]) => {
		if (!String(args[0]).includes("ExperimentalWarning")) logged.push(args)
	})
	assert.equal((await module.focus_client(" abc ")).ok, true)
	assert.equal((await module.close_client({ address: "0x12" })).ok, true)
	assert.equal((await module.raise_client({ address: "0x7" })).ok, true)
	assert.equal(
		(
			await module.move_client_to_workspace_silent(5, {
				get_address: () => " 34 ",
			})
		).ok,
		true,
	)
	assert.equal(
		(await module.focus_client_and_toggle_fullscreen({ address: "9" })).ok,
		true,
	)
	assert.deepEqual(hyprland.messages, [
		'dispatch hl.dsp.focus({ window = "address:0xabc" })',
		'dispatch hl.dsp.window.close({ window = "address:0x12" })',
		'dispatch hl.dsp.window.alter_zorder({ mode = "top", window = "address:0x7" })',
		'dispatch hl.dsp.window.move({ workspace = 5, follow = false, window = "address:0x34" })',
		'dispatch hl.dsp.focus({ window = "address:0x9" })',
		'dispatch hl.dsp.window.fullscreen({ window = "address:0x9" })',
	])
	assert.equal(logged.length, 0)
	const missing = await module.focus_client(null)
	assert.equal(missing.ok, false)
	assert.equal(missing.err.message, "Client has no address")
	hyprland.reply = "denied"
	const fullscreen = await module.focus_client_and_toggle_fullscreen({
		address: "9",
	})
	assert.equal(fullscreen.ok, false)
	assert.equal(hyprland.messages.length, 7)
	assert.deepEqual(
		logged.map(([tag, error]) => [tag, (error as Error).message]),
		[
			["windowing.focus: Failed to focus client", "Client has no address"],
			[
				"windowing.focus: Failed to focus client",
				'Hyprland rejected dispatch hl.dsp.focus({ window = "address:0x9" }): denied',
			],
		],
	)
	const closed = await module.close_client("")
	assert.equal(closed.ok, false)
	assert.equal(logged.at(-1)![0], "windowing.close: Failed to close client")
})

test("window helpers toggle, report toggles, release and title clients", async () => {
	const { module, app } = await load_windowing()
	const events: string[] = []
	const window = {
		name: "bar",
		visible: false,
		show() {
			this.visible = true
			events.push("show")
		},
		hide() {
			this.visible = false
			events.push("hide")
		},
		set_visible(visible: boolean) {
			events.push(`visible:${visible}`)
		},
		destroy() {
			events.push("destroy")
		},
	}
	Object.assign(app, { get_window: (name: string) => app.windows.get(name) })
	app.windows.set("bar", window)
	module.toggle_window(undefined)
	module.toggle_window("missing")
	module.toggle_window("bar")
	module.toggle_window("bar")
	const toggled: string[] = []
	const stop = module.on_window_toggle("bar", (win: any) =>
		toggled.push(win.name),
	)
	app.emit("window-toggled", { name: "other" })
	app.emit("window-toggled", window)
	stop()
	app.emit("window-toggled", window)
	assert.deepEqual(toggled, ["bar"])
	module.schedule_monitor_window_release(null)
	module.schedule_monitor_window_release(window)
	assert.deepEqual(events, ["show", "hide", "visible:false", "destroy"])
	const calls: string[] = []
	module.dispatch_client_button_action(3, {
		primary: () => calls.push("primary"),
		secondary: () => calls.push("secondary"),
		middle: () => calls.push("middle"),
	})
	module.dispatch_client_button_action(9, {
		primary: () => calls.push("primary"),
		secondary: () => calls.push("secondary"),
		middle: () => calls.push("middle"),
	})
	assert.deepEqual(calls, ["secondary"])
	const titled = emitter({ title: "", class: "org.gnome.NAUTILUS" })
	const title = module.create_client_title_accessor(titled)
	assert.equal(title(), "Nautilus")
	titled.title = "Home"
	assert.equal(title(), "Home")
	titled.title = ""
	titled.class = ""
	assert.equal(title(), "Unknown")
})
