import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as icons from "../../lib/icons.ts"
import { accessor, create_state, jsx_runtime, make, nodes } from "../helpers.ts"

const PSK = 0x100
const SAE = 0x400
const NEED_AUTH = 60
const PREPARE = 40
const ACTIVATED = 100
const FAILED = 120
const NO_SECRETS = 7
const UNKNOWN = 1
const INVALIDPROPERTY = 2

async function flush() {
	for (let i = 0; i < 40; i++)
		await new Promise((resolve) => setImmediate(resolve))
}

class ConnectionError extends Error {
	static INVALIDPROPERTY = INVALIDPROPERTY
	code: number
	constructor(code: number, message: string) {
		super(message)
		this.code = code
	}
}

class Cancellable {
	cancelled = false
	cancel() {
		this.cancelled = true
	}
}

function make_security(psk: string) {
	return {
		psk,
		get_psk() {
			return this.psk
		},
		set_property(name: string, value: string) {
			if (name === "psk") this.psk = value
		},
	}
}

function make_ap(ssid: string, bssid: string, flags = PSK) {
	return {
		ssid,
		bssid,
		strength: 50,
		frequency: 2412,
		wpaFlags: 0,
		rsnFlags: flags,
		requiresPassword: flags !== 0,
		iconName: "ap",
		get_path: () => `/ap/${bssid}`,
	}
}

async function fixture() {
	const calls: [string, unknown][] = []
	const errors: unknown[][] = []
	const warnings: unknown[][] = []
	const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
	const fail = new Map<string, unknown>()
	const hang = new Set<string>()
	const refuse = new Map<string, unknown>()
	const handlers = new Map<string, (...args: any[]) => void>()
	const windows = { "wifi-auth": { shown: false } }
	const menu = { opened: null as string | null }
	const cancellables: Record<string, Cancellable> = {}
	const hooks: Record<string, () => void> = {}
	let serial = 0

	const later = (
		name: string,
		cancellable: Cancellable,
		cb,
		source,
		value?: unknown,
	) => {
		cancellables[name] = cancellable
		hooks[name]?.()
		if (refuse.has(name)) throw refuse.get(name)
		if (hang.has(name)) return
		setImmediate(() => cb(source, { name, value }))
	}
	const finish = (name: string) => {
		if (fail.has(name)) throw fail.get(name)
	}

	const make_connection = (bssid: string, security = make_security("old")) => ({
		bssid,
		security,
		get_flags: () => 0,
		get_setting_wireless: () => ({ bssid }),
		get_setting_wireless_security: () => security,
		get_setting_connection: () => ({ set_property() {} }),
		commit_changes_async(_save, cancellable, cb) {
			calls.push(["commit", this])
			later("commit", cancellable, cb, this)
		},
		commit_changes_finish() {
			finish("commit")
			return true
		},
		delete_async(cancellable, cb) {
			calls.push(["delete", this])
			later("delete", cancellable, cb, this)
		},
		delete_finish() {
			finish("delete")
			return true
		},
	})

	const make_active = (connection) => {
		const path = `/active/${++serial}`
		return { get_path: () => path, get_connection: () => connection }
	}

	const env = {
		state: PREPARE,
		reason: UNKNOWN,
		active_connection: null as any,
		active_bssid: null as string | null,
	}

	const device = {
		get_active_access_point: () =>
			env.active_bssid ? { get_bssid: () => env.active_bssid } : null,
		get_access_point_by_path: () => ({ connection_valid: () => true }),
		connection_valid: () => true,
		get_active_connection: () => env.active_connection,
		get_state_reason: () => env.reason,
	}

	const client = {
		connections: [] as any[],
		get_connections() {
			return this.connections
		},
		activate_connection_async(connection, _device, _path, cancellable, cb) {
			calls.push(["activate", connection])
			this.last = make_active(connection)
			later("activate", cancellable, cb, this, this.last)
		},
		activate_connection_finish(res) {
			finish("activate")
			return res.value
		},
		add_and_activate_connection2(_c, _device, _path, options, cancellable, cb) {
			calls.push(["add", options.value.persist?.value ?? null])
			this.last = make_active(make_connection("created"))
			later("add", cancellable, cb, this, this.last)
		},
		add_and_activate_connection2_finish(res) {
			finish("add")
			return [res.value]
		},
		deactivate_connection_async(active, cancellable, cb) {
			calls.push(["deactivate", active])
			later("deactivate", cancellable, cb, this)
		},
		deactivate_connection_finish() {
			finish("deactivate")
			return true
		},
		last: null as any,
	}

	const wifi = {
		set_enabled(value: boolean) {
			calls.push(["enabled", value])
			finish("enabled")
			this.enabled = value
		},
		scan() {
			calls.push(["scan", null])
			finish("scan")
		},
		enabled: true,
		accessPoints: [] as any[],
		device,
		iconName: "wifi",
		get state() {
			return env.state
		},
		connect(signal: string, cb) {
			handlers.set(signal, cb)
			return ++serial
		},
		disconnect() {},
	}

	const network_handlers = new Map<string, () => void>()
	const network: Record<string, any> = {
		wifi,
		client,
		primary: 1,
		connect(signal: string, cb) {
			network_handlers.set(signal, cb)
			return ++serial
		},
		disconnect() {},
	}

	const imports = {
		"$lib/app": {
			default: {
				get_window: (name) => ({
					show: () => {
						windows[name].shown = true
					},
					hide: () => {
						windows[name].shown = false
					},
				}),
				connect() {},
			},
		},
		"ags/gtk4": {
			Gdk: { BUTTON_MIDDLE: 2 },
			Gtk: {
				Align: { CENTER: 1, END: 2, START: 3 },
				Orientation: { VERTICAL: 1, HORIZONTAL: 0 },
				PolicyType: { NEVER: 1 },
				ScrolledWindow: "scroll",
				Separator: "separator",
				Window: "window",
				GestureClick: "gesture",
			},
		},
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"$lib/time": {
			idle: (fn) => {
				setImmediate(fn)
				return { cancel() {} }
			},
			timeout: (ms, fn) => {
				const timer = { ms, fn, cancelled: false }
				timers.push(timer)
				return {
					cancel() {
						timer.cancelled = true
					},
				}
			},
		},
		ags: {
			createBinding: (object, ...path) =>
				accessor(() => path.reduce((value, key) => value?.[key], object)),
			createComputed: (fn) => accessor(fn),
			createState: create_state,
			onCleanup: () => {},
			With: (props) => make("with", props),
			For: (props) => make("for", props),
		},
		"gi://AstalNetwork": {
			default: {
				get_default: () => network,
				Primary: { WIRED: 2, WIFI: 1 },
				DeviceState: { NEED_AUTH, FAILED, ACTIVATED },
			},
		},
		"gi://GLib": {
			default: {
				Variant: class {
					value: unknown
					constructor(_type, value) {
						this.value = value
					}
				},
				Bytes: class {},
				uuid_string_random: () => "uuid",
			},
		},
		"gi://Gio": { default: { Cancellable } },
		"gi://NM": {
			default: {
				"80211ApSecurityFlags": { KEY_MGMT_PSK: PSK, KEY_MGMT_SAE: SAE },
				SettingsConnectionFlags: { VOLATILE: 1 },
				DeviceStateReason: {
					SUPPLICANT_DISCONNECT: 8,
					NO_SECRETS,
					UNKNOWN,
				},
				ConnectionError,
				SimpleConnection: {
					new: () => ({ add_setting() {} }),
					new_clone: (connection) => ({
						get_setting_connection: () => ({ set_property() {} }),
						get_setting_wireless_security: () =>
							connection.security ? make_security("") : null,
					}),
				},
				SettingWireless: { new: () => ({ set_property() {} }) },
				SettingWirelessSecurity: { new: () => ({ set_property() {} }) },
			},
		},
		"widget/shared/Placeholder": {
			Placeholder: (props) => make("placeholder", props),
		},
		"./MenuControls": {
			ToggleButton: (props) => make("toggle", props),
			Menu: (props) => make("menu", props),
			SettingsButton: (props) => make("settings", props),
			open_gnome_settings() {},
			quick_settings_submenu: { opened: accessor(() => menu.opened) },
		},
		"$shell/options": { default: { transition: { duration: 0 } } },
	}

	const { Network } = await load_module(
		"widget/Bar/components/QuickSettings/components/Network.tsx",
		imports,
	)

	await flush()
	const original_error = console.error
	const original_warn = console.warn
	console.error = (...args) => errors.push(args)
	console.warn = (...args) => warnings.push(args)
	const restore = () => {
		console.error = original_error
		console.warn = original_warn
	}

	const window = nodes(Network.Wifi.Window())
	const window_buttons = window.filter((node) => node.type === "button")
	const entry = window.find((node) => node.type === "entry")
	const status = window.find(
		(node) => node.type === "label" && "visible" in node.props,
	)
	assert.ok(entry && status)

	const items = () =>
		nodes(Network.Wifi.Selector()).filter(
			(node) =>
				node.type === "button" &&
				nodes(node.props.children).some((child) => child.type === "gesture"),
		)

	const ap = (bssid: string) =>
		wifi.accessPoints.findIndex((candidate) => candidate.bssid === bssid)

	return {
		Network,
		menu,
		window_buttons,
		calls,
		errors,
		warnings,
		timers,
		fail,
		hang,
		refuse,
		handlers,
		network_handlers,
		windows,
		cancellables,
		hooks,
		env,
		wifi,
		client,
		network,
		make_connection,
		restore,
		add_ap(ap) {
			wifi.accessPoints = [...wifi.accessPoints, ap]
			return ap
		},
		save(bssid: string, security?) {
			const connection = make_connection(bssid, security)
			client.connections = [...client.connections, connection]
			return connection
		},
		async click(bssid: string) {
			items()[ap(bssid)].props.onClicked()
			await flush()
		},
		async forget(bssid: string) {
			const gesture = nodes(items()[ap(bssid)].props.children).find(
				(node) => node.type === "gesture",
			)
			gesture?.props.onPressed({ reset() {} })
			await flush()
		},
		async connect(password: string) {
			entry.props.onNotifyText({ text: password })
			window_buttons[1].props.onClicked()
			await flush()
		},
		status: () => status.props.label(),
		tags: () => errors.map((args) => args[0]),
	}
}

test("forgetting a network logs a failed delete", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		const saved = t.save("aa")
		const failure = new Error("delete failed")
		t.fail.set("delete", failure)
		await t.forget("aa")
		assert.deepEqual(t.calls, [["delete", saved]])
		assert.deepEqual(t.errors, [
			["network.forget: Failed to forget Wi-Fi network", failure],
		])
	} finally {
		t.restore()
	}
})

test("a hung NM call is cancelled by its 10 s deadline", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		t.save("aa")
		t.hang.add("delete")
		await t.forget("aa")
		const deadline = t.timers.find((timer) => timer.ms === 10_000)
		assert.ok(deadline)
		assert.equal(t.cancellables.delete.cancelled, false)
		deadline.fn()
		assert.equal(t.cancellables.delete.cancelled, true)
	} finally {
		t.restore()
	}
})

test("a settled NM call cancels its deadline", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		t.save("aa")
		await t.forget("aa")
		const deadline = t.timers.find((timer) => timer.ms === 10_000)
		assert.equal(deadline?.cancelled, true)
		assert.deepEqual(t.errors, [])
	} finally {
		t.restore()
	}
})

test("a failed saved activation resets and logs", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		const saved = t.save("aa")
		const failure = new Error("activate failed")
		t.fail.set("activate", failure)
		await t.click("aa")
		assert.deepEqual(t.calls, [["activate", saved]])
		assert.deepEqual(t.errors, [
			["network.connect: Failed to connect to Wi-Fi", failure],
		])
		assert.equal(t.status(), "")
	} finally {
		t.restore()
	}
})

test("a rejected password shows the invalid prompt without logging", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		await t.click("aa")
		assert.equal(t.windows["wifi-auth"].shown, true)
		t.fail.set(
			"add",
			new ConnectionError(
				INVALIDPROPERTY,
				"802-11-wireless-security.psk: invalid",
			),
		)
		await t.connect("short")
		assert.equal(t.status(), "Incorrect password. Try again.")
		assert.deepEqual(t.errors, [])
	} finally {
		t.restore()
	}
})

test("a missing password fails the connection", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		await t.click("aa")
		await t.connect("")
		assert.equal(t.status(), "Could not connect. Try again.")
		assert.deepEqual(t.tags(), ["network.connect: Failed to connect to Wi-Fi"])
		assert.equal(
			(t.errors[0][1] as Error).message,
			"A password is required for this Wi-Fi network",
		)
		assert.deepEqual(t.calls, [])
	} finally {
		t.restore()
	}
})

test("a vanished access point fails the connection", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		await t.click("aa")
		t.wifi.accessPoints = []
		await t.connect("password")
		assert.equal(t.status(), "Could not connect. Try again.")
		assert.equal(
			(t.errors[0][1] as Error).message,
			"Wi-Fi access point is no longer available",
		)
		assert.deepEqual(t.calls, [])
	} finally {
		t.restore()
	}
})

test("a failed commit rolls back the new connection", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		await t.click("aa")
		const failure = new Error("commit failed")
		t.fail.set("commit", failure)
		t.hooks.add = () => {
			t.env.state = ACTIVATED
			t.env.active_bssid = "aa"
			t.env.active_connection = t.client.last
		}
		await t.connect("password")
		const active = t.client.last
		const created = active.get_connection()
		assert.deepEqual(t.calls, [
			["add", "volatile"],
			["commit", created],
			["deactivate", active],
			["delete", created],
		])
		assert.deepEqual(t.errors, [
			["network.settle: Failed to save Wi-Fi connection", failure],
		])
		assert.equal(t.status(), "Could not connect. Try again.")
	} finally {
		t.restore()
	}
})

test("a committed connection closes the prompt", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		await t.click("aa")
		t.hooks.add = () => {
			t.env.state = ACTIVATED
			t.env.active_bssid = "aa"
			t.env.active_connection = t.client.last
		}
		await t.connect("password")
		const created = t.client.last.get_connection()
		assert.deepEqual(t.calls.slice(1), [["commit", created]])
		assert.deepEqual(t.errors, [])
		assert.equal(t.windows["wifi-auth"].shown, false)
		assert.equal(t.status(), "")
	} finally {
		t.restore()
	}
})

async function reject_saved(t: Awaited<ReturnType<typeof fixture>>, security?) {
	t.add_ap(make_ap("home", "aa"))
	const saved = t.save("aa", security)
	t.env.state = NEED_AUTH
	t.env.reason = NO_SECRETS
	await t.click("aa")
	t.env.state = PREPARE
	t.env.reason = UNKNOWN
	return saved
}

test("a credential failure rolls back and asks for the password", async () => {
	const t = await fixture()
	try {
		const saved = await reject_saved(t)
		const active = t.client.last
		assert.deepEqual(t.calls, [
			["activate", saved],
			["deactivate", active],
		])
		assert.equal(t.windows["wifi-auth"].shown, true)
		assert.deepEqual(t.errors, [])
	} finally {
		t.restore()
	}
})

test("a failed restore is logged and still asks for the password", async () => {
	const t = await fixture()
	try {
		const failure = new Error("deactivate failed")
		t.fail.set("deactivate", failure)
		await reject_saved(t)
		assert.deepEqual(t.errors, [
			["network.settle: Failed to restore Wi-Fi connection", failure],
		])
		assert.equal(t.windows["wifi-auth"].shown, true)
	} finally {
		t.restore()
	}
})

test("a replaced saved password is restored when its commit fails", async () => {
	const t = await fixture()
	try {
		const saved = await reject_saved(t)
		t.calls.length = 0
		const failure = new Error("commit failed")
		t.fail.set("commit", failure)
		t.hooks.add = () => {
			t.env.state = ACTIVATED
			t.env.active_bssid = "aa"
			t.env.active_connection = t.client.last
		}
		await t.connect("new")
		const active = t.client.last
		assert.equal(saved.security.psk, "old")
		assert.deepEqual(t.calls, [
			["add", "volatile"],
			["commit", saved],
			["deactivate", active],
			["delete", active.get_connection()],
		])
		assert.deepEqual(t.errors, [
			["network.settle: Failed to save Wi-Fi connection", failure],
		])
		assert.equal(t.status(), "Could not connect. Try again.")
	} finally {
		t.restore()
	}
})

test("a password save that throws is logged and later networks still connect", async () => {
	const t = await fixture()
	try {
		const saved = await reject_saved(t)
		const failure = new Error("psk is read-only")
		saved.security.set_property = () => {
			throw failure
		}
		t.hooks.add = () => {
			t.env.state = ACTIVATED
			t.env.active_bssid = "aa"
			t.env.active_connection = t.client.last
		}
		await t.connect("new")
		assert.deepEqual(t.errors.at(-1), [
			"network.settle: Failed to save Wi-Fi connection",
			failure,
		])
		t.calls.length = 0
		t.hooks.add = () => {}
		t.add_ap(make_ap("cafe", "bb"))
		await t.click("bb")
		await t.connect("cafe-password")
		assert.deepEqual(t.calls[0], ["add", "volatile"])
	} finally {
		t.restore()
	}
})

test("a replaced saved password is kept when its commit succeeds", async () => {
	const t = await fixture()
	try {
		const saved = await reject_saved(t)
		t.hooks.add = () => {
			t.env.state = ACTIVATED
			t.env.active_bssid = "aa"
			t.env.active_connection = t.client.last
		}
		await t.connect("new")
		assert.equal(saved.security.psk, "new")
		assert.deepEqual(t.errors, [])
		assert.equal(t.windows["wifi-auth"].shown, false)
	} finally {
		t.restore()
	}
})

test("a saved connection without security settings fails", async () => {
	const t = await fixture()
	try {
		await reject_saved(t, null)
		t.calls.length = 0
		await t.connect("new")
		assert.equal(t.status(), "Could not connect. Try again.")
		assert.equal(
			(t.errors[0][1] as Error).message,
			"Saved Wi-Fi connection has incomplete settings",
		)
		assert.deepEqual(t.calls, [])
	} finally {
		t.restore()
	}
})

test("a failed rollback of a superseded activation is logged", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		t.save("aa")
		await t.click("aa")
		const failure = new Error("deactivate failed")
		t.fail.set("deactivate", failure)
		await t.click("aa")
		assert.deepEqual(t.errors, [
			[
				"network.activate: Failed to cancel superseded Wi-Fi activation",
				failure,
			],
		])
	} finally {
		t.restore()
	}
})

test("a vanished Wi-Fi device rolls back the activation", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		t.save("aa")
		const failure = new Error("deactivate failed")
		t.fail.set("deactivate", failure)
		t.hooks.activate = () => {
			t.network.wifi = null
		}
		await t.click("aa")
		assert.deepEqual(
			t.calls.map(([name]) => name),
			["activate", "deactivate"],
		)
		assert.deepEqual(t.errors, [
			["network.activate: Failed to cancel Wi-Fi activation", failure],
		])
	} finally {
		t.restore()
	}
})

test("an NM call that fails to start is logged", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		t.save("aa")
		const failure = new Error("delete refused")
		t.refuse.set("delete", failure)
		await t.forget("aa")
		assert.deepEqual(t.errors, [
			["network.forget: Failed to forget Wi-Fi network", failure],
		])
	} finally {
		t.restore()
	}
})

async function commit_fails(t: Awaited<ReturnType<typeof fixture>>) {
	t.add_ap(make_ap("home", "aa"))
	await t.click("aa")
	t.fail.set("commit", new Error("commit failed"))
	t.hooks.add = () => {
		t.env.state = ACTIVATED
		t.env.active_bssid = "aa"
		t.env.active_connection = t.client.last
	}
}

test("a failed deactivate still deletes and reports the deactivate", async () => {
	const t = await fixture()
	try {
		await commit_fails(t)
		const failure = new Error("deactivate failed")
		t.fail.set("deactivate", failure)
		await t.connect("password")
		assert.deepEqual(
			t.calls.map(([name]) => name),
			["add", "commit", "deactivate", "delete"],
		)
		assert.deepEqual(t.errors[0], [
			"network.activate: Failed to cancel unsaved Wi-Fi connection",
			failure,
		])
	} finally {
		t.restore()
	}
})

test("a failed delete outranks a failed deactivate", async () => {
	const t = await fixture()
	try {
		await commit_fails(t)
		const failure = new Error("delete failed")
		t.fail.set("deactivate", new Error("deactivate failed"))
		t.fail.set("delete", failure)
		await t.connect("password")
		assert.deepEqual(t.errors[0], [
			"network.activate: Failed to cancel unsaved Wi-Fi connection",
			failure,
		])
	} finally {
		t.restore()
	}
})

test("an activation superseded mid-flight is rolled back silently", async () => {
	const t = await fixture()
	try {
		t.add_ap(make_ap("home", "aa"))
		const saved = t.save("aa")
		t.fail.set("deactivate", new Error("deactivate failed"))
		let first = true
		let superseded: unknown = null
		t.hooks.activate = () => {
			if (!first) return
			first = false
			superseded = t.client.last
			void t.click("aa")
		}
		await t.click("aa")
		await flush()
		assert.deepEqual(t.calls, [
			["activate", saved],
			["activate", saved],
			["deactivate", superseded],
		])
		assert.deepEqual(t.errors, [])
	} finally {
		t.restore()
	}
})

async function with_fixture(
	body: (t: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
	const t = await fixture()
	try {
		await body(t)
	} finally {
		t.restore()
	}
}

function activate_on_add(t: Awaited<ReturnType<typeof fixture>>) {
	t.hooks.add = () => {
		t.env.state = ACTIVATED
		t.env.active_bssid = "aa"
		t.env.active_connection = t.client.last
	}
}

test("the selector lists the strongest access point per named network", () =>
	with_fixture(async (t) => {
		t.add_ap({ ...make_ap("home", "aa"), strength: 40, frequency: 5180 })
		t.add_ap({ ...make_ap("home", "ab"), strength: 70, frequency: 5955 })
		t.add_ap({ ...make_ap("cafe", "cc", 0), strength: 55 })
		t.add_ap({ ...make_ap("", "dd"), strength: 99 })
		t.add_ap({
			...make_ap("legacy", "ee", 0),
			wpaFlags: 2,
			strength: 10,
		})
		t.add_ap({
			...make_ap("wep", "ff", 0),
			requiresPassword: true,
			strength: 5,
		})
		t.save("ab")
		t.network.wifi.activeAccessPoint = { ssid: "cafe" }
		const items = nodes(t.Network.Wifi.Selector()).filter(
			(node) => node.props.class === "wifi-item horizontal",
		)
		const rows = items.map((item) =>
			nodes(item)
				.filter((node) => node.type === "label")
				.map((node) =>
					typeof node.props.label === "function"
						? node.props.label()
						: node.props.label,
				),
		)
		assert.deepEqual(rows, [
			["home", "", "6 GHz"],
			["cafe", "Open", "2.4 GHz"],
			["legacy", "WPA", "2.4 GHz"],
			["wep", "WEP", "2.4 GHz"],
		])
		const ticks = items.map((item) =>
			nodes(item)
				.find((node) => node.props.iconName === icons.default.ui.tick)!
				.props.opacity(),
		)
		assert.deepEqual(ticks, [0, 1, 0, 0])
		const buttons = nodes(t.Network.Wifi.Selector()).filter(
			(node) => node.type === "button" && "tooltipText" in node.props,
		)
		assert.deepEqual(
			buttons.map((button) => button.props.tooltipText()),
			["Middle click to forget network", "", "", ""],
		)
		t.wifi.accessPoints = []
		const empty = nodes(t.Network.Wifi.Selector())
		const placeholder = empty.find((node) => node.type === "placeholder")!
		assert.equal(placeholder.props.label(), "Searching for Wi-Fi networks...")
		t.network.wifi = null
		const missing = nodes(t.Network.Wifi.Selector())
		assert.equal(
			missing.find((node) => node.type === "placeholder")!.props.label,
			"No device found",
		)
	}))

test("a vanished access point click resets with a warning", () =>
	with_fixture(async (t) => {
		t.add_ap(make_ap("home", "aa"))
		t.hooks.none = () => {}
		const item = nodes(t.Network.Wifi.Selector()).find(
			(node) => node.type === "button" && "tooltipText" in node.props,
		)!
		t.wifi.accessPoints = []
		item.props.onClicked()
		await flush()
		assert.deepEqual(t.warnings, [
			["network.connect: Wi-Fi access point is no longer available"],
		])
		assert.deepEqual(t.calls, [])
		assert.deepEqual(t.errors, [])
		assert.equal(t.windows["wifi-auth"].shown, false)
	}))

test("an open network activates without persisting", () =>
	with_fixture(async (t) => {
		t.add_ap(make_ap("cafe", "aa", 0))
		activate_on_add(t)
		await t.click("aa")
		assert.deepEqual(t.calls, [["add", null]])
		assert.deepEqual(t.errors, [])
		assert.equal(t.windows["wifi-auth"].shown, false)
	}))

test("a saved network activation that fails rolls back silently", () =>
	with_fixture(async (t) => {
		t.add_ap(make_ap("home", "aa"))
		const saved = t.save("aa")
		t.env.state = FAILED
		await t.click("aa")
		assert.deepEqual(t.calls, [
			["activate", saved],
			["deactivate", t.client.last],
		])
		assert.deepEqual(t.errors, [])
		assert.equal(t.windows["wifi-auth"].shown, false)
		assert.equal(t.status(), "")
	}))

for (const [state, reason, asks] of [
	[FAILED, NO_SECRETS, true],
	[NEED_AUTH, 8, true],
	[NEED_AUTH, UNKNOWN, false],
	[FAILED, 8, false],
] as [number, number, boolean][])
	test(`state ${state} with reason ${reason} ${asks ? "asks" : "does not ask"} for a password`, () =>
		with_fixture(async (t) => {
			t.add_ap(make_ap("home", "aa"))
			t.save("aa")
			t.env.state = state
			t.env.reason = reason
			await t.click("aa")
			assert.equal(t.windows["wifi-auth"].shown, asks)
			const rolled_back = t.calls.some(([name]) => name === "deactivate")
			assert.equal(rolled_back, state === FAILED || asks)
		}))

test("an open network never treats missing secrets as a password failure", () =>
	with_fixture(async (t) => {
		t.add_ap(make_ap("cafe", "aa", 0))
		t.env.state = NEED_AUTH
		t.env.reason = NO_SECRETS
		await t.click("aa")
		assert.equal(t.windows["wifi-auth"].shown, false)
		assert.deepEqual(t.calls, [["add", null]])
	}))

async function pending_prompt(t: Awaited<ReturnType<typeof fixture>>) {
	t.add_ap(make_ap("home", "aa"))
	await t.click("aa")
	await t.connect("password")
	assert.equal(t.status(), "Checking password...")
	assert.equal(t.window_buttons[1].props.sensitive(), false)
}

test("disabling Wi-Fi during a prompted activation fails it", () =>
	with_fixture(async (t) => {
		await pending_prompt(t)
		t.handlers.get("notify::enabled")!()
		await flush()
		assert.equal(t.status(), "Checking password...")
		t.wifi.enabled = false
		t.handlers.get("notify::enabled")!()
		await flush()
		assert.equal(t.status(), "Could not connect. Try again.")
		assert.deepEqual(
			t.calls.map(([name]) => name),
			["add", "deactivate", "delete"],
		)
		assert.equal(t.windows["wifi-auth"].shown, true)
	}))

test("a replaced Wi-Fi device fails the prompted activation", () =>
	with_fixture(async (t) => {
		await pending_prompt(t)
		t.network_handlers.get("notify::wifi")!()
		await flush()
		assert.equal(t.status(), "Checking password...")
		t.network.wifi = { ...t.wifi }
		t.network_handlers.get("notify::wifi")!()
		await flush()
		assert.equal(t.status(), "Could not connect. Try again.")
	}))

test("a prompted activation that never settles fails after 25 s", () =>
	with_fixture(async (t) => {
		await pending_prompt(t)
		const deadlines = t.timers.filter((timer) => timer.ms === 25_000)
		assert.equal(deadlines.length, 2)
		assert.equal(deadlines[0].cancelled, true)
		deadlines[1].fn()
		await flush()
		assert.equal(t.status(), "Could not connect. Try again.")
		assert.deepEqual(
			t.calls.map(([name]) => name),
			["add", "deactivate", "delete"],
		)
	}))

test("the activation deadline cancels a hung activation", () =>
	with_fixture(async (t) => {
		t.add_ap(make_ap("home", "aa"))
		t.save("aa")
		t.hang.add("activate")
		await t.click("aa")
		const deadline = t.timers.find((timer) => timer.ms === 25_000)!
		assert.equal(t.cancellables.activate.cancelled, false)
		deadline.fn()
		assert.equal(t.cancellables.activate.cancelled, true)
	}))

test("cancelling the prompt hides it, resets and rolls back the pending activation", () =>
	with_fixture(async (t) => {
		await pending_prompt(t)
		t.window_buttons[0].props.onClicked()
		await flush()
		assert.equal(t.windows["wifi-auth"].shown, false)
		assert.equal(t.status(), "")
		assert.deepEqual(
			t.calls.map(([name]) => name),
			["add", "deactivate", "delete"],
		)
		assert.deepEqual(t.errors, [])
	}))

test("a rejected password shakes the entry once then settles", () =>
	with_fixture(async (t) => {
		t.add_ap(make_ap("home", "aa"))
		await t.click("aa")
		t.env.state = NEED_AUTH
		t.env.reason = NO_SECRETS
		await t.connect("wrong")
		assert.equal(t.status(), "Incorrect password. Try again.")
		const entry = nodes(t.Network.Wifi.Window()).find(
			(node) => node.type === "entry",
		)!
		assert.equal(entry.props.class(), "shake")
		assert.equal(entry.props.text(), "")
		const shake = t.timers.find((timer) => timer.ms === 450)!
		shake.fn()
		assert.equal(entry.props.class(), "")
		assert.deepEqual(t.errors, [])
	}))

test("the toggle enables, scans and disables Wi-Fi", () =>
	with_fixture(async (t) => {
		const toggle = () =>
			nodes(t.Network.Wifi.Toggle()).find((node) => node.type === "toggle")!
		t.wifi.enabled = false
		t.network.wifi.activeAccessPoint = null
		assert.equal(toggle().props.label(), "Not Connected")
		toggle().props.onToggle()
		assert.deepEqual(t.calls, [["enabled", true]])
		const scan = t.timers.find((timer) => timer.ms === 100)!
		scan.fn()
		assert.deepEqual(t.calls.at(-1), ["scan", null])
		toggle().props.onArrow()
		assert.equal(t.calls.length, 2)
		t.menu.opened = "wifi-selector"
		toggle().props.onArrow()
		assert.deepEqual(t.calls.at(-1), ["enabled", true])
		t.wifi.enabled = false
		t.timers.at(-1)!.fn()
		assert.equal(t.calls.length, 3)
		t.wifi.enabled = true
		t.network.wifi = { ...t.wifi }
		t.timers.at(-1)!.fn()
		assert.equal(t.calls.length, 3)
		t.network.wifi = t.wifi
		toggle().props.onToggle()
		assert.deepEqual(t.calls.at(-1), ["enabled", false])
		const failure = new Error("rfkill")
		t.fail.set("enabled", failure)
		toggle().props.onToggle()
		toggle().props.onToggle()
		assert.equal(t.timers.filter((timer) => timer.ms === 100).length, 2)
		t.fail.delete("enabled")
		t.wifi.enabled = false
		toggle().props.onToggle()
		const scan_failure = new Error("busy")
		t.fail.set("scan", scan_failure)
		t.timers.at(-1)!.fn()
		assert.deepEqual(t.errors, [
			["network.wifi: Failed to enable Wi-Fi", failure],
			["network.wifi: Failed to enable Wi-Fi", failure],
			["network.wifi: Failed to scan", scan_failure],
		])
		t.wifi.enabled = true
		t.fail.set("enabled", failure)
		toggle().props.onToggle()
		assert.deepEqual(t.errors.at(-1), [
			"network.wifi: Failed to disable Wi-Fi",
			failure,
		])
		t.network.wifi = null
		assert.equal(toggle().props.label, "No device")
	}))

test("the state icon follows the primary adapter", () =>
	with_fixture(async (t) => {
		const state = () => nodes(t.Network.State())
		assert.equal(state()[0].props.visible(), true)
		assert.equal(
			state()
				.find((node) => node.type === "image")!
				.props.iconName(),
			"wifi",
		)
		t.network.primary = 2
		t.network.wired = { iconName: "wired" }
		assert.equal(
			state()
				.find((node) => node.type === "image")!
				.props.iconName(),
			"wired",
		)
		t.network.primary = 0
		assert.equal(state()[0].props.visible(), false)
	}))

test("a click superseded before its activation starts never activates", () =>
	with_fixture(async (t) => {
		t.add_ap(make_ap("home", "aa"))
		const saved = t.save("aa")
		const item = nodes(t.Network.Wifi.Selector()).find(
			(node) => node.type === "button" && "tooltipText" in node.props,
		)!
		item.props.onClicked()
		item.props.onClicked()
		await flush()
		assert.deepEqual(t.calls, [["activate", saved]])
		assert.deepEqual(t.errors, [])
	}))

test("a Wi-Fi device vanishing during a prompted activation fails it", () =>
	with_fixture(async (t) => {
		t.add_ap(make_ap("home", "aa"))
		await t.click("aa")
		t.hooks.add = () => {
			t.network.wifi = null
		}
		await t.connect("password")
		assert.deepEqual(
			t.calls.map(([name]) => name),
			["add", "deactivate", "delete"],
		)
		assert.equal(t.status(), "Could not connect. Try again.")
		assert.deepEqual(t.errors, [])
	}))
