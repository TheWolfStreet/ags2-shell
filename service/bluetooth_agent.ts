import { createState } from "ags"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import app from "$lib/app"
import { attempt, err, log_error, ok, type result } from "$lib/result"

const agent_path = "/io/Astal/ags2shell/bluetooth/agent"
const agent_capability = "DisplayYesNo"
const call_timeout_ms = 5000
const pair_timeout_ms = 120000

const interface_xml = `
<node>
  <interface name="org.bluez.Agent1">
    <method name="Release"/>
    <method name="RequestPinCode">
      <arg type="o" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="DisplayPinCode">
      <arg type="o" direction="in"/>
      <arg type="s" direction="in"/>
    </method>
    <method name="RequestPasskey">
      <arg type="o" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="DisplayPasskey">
      <arg type="o" direction="in"/>
      <arg type="u" direction="in"/>
      <arg type="q" direction="in"/>
    </method>
    <method name="RequestConfirmation">
      <arg type="o" direction="in"/>
      <arg type="u" direction="in"/>
    </method>
    <method name="RequestAuthorization">
      <arg type="o" direction="in"/>
    </method>
    <method name="AuthorizeService">
      <arg type="o" direction="in"/>
      <arg type="s" direction="in"/>
    </method>
    <method name="Cancel"/>
  </interface>
</node>`

export type agent_prompt =
	| { kind: "confirm"; device: string; passkey: string }
	| { kind: "display"; device: string; passkey: string }
	| { kind: "passkey"; device: string }
	| { kind: "pin"; device: string }

const [prompt, set_prompt] = createState<agent_prompt | null>(null)
export { prompt as agent_prompt_state }

let expected_device = ""
let pending_invocation: Gio.DBusMethodInvocation | null = null
let registration = 0
let bus: Gio.DBusConnection | null = null

function expect_pairing(address: string) {
	expected_device = address.toUpperCase()
}

function forget_pairing() {
	expected_device = ""
}

function address_from_path(device_path: string) {
	const tail = device_path.split("/").pop() ?? ""
	if (!tail.startsWith("dev_")) return ""
	return tail.slice(4).replaceAll("_", ":").toUpperCase()
}

function initiated_by_user(device_path: string) {
	if (!expected_device) return false
	return address_from_path(device_path) === expected_device
}

function device_path(
	connection: Gio.DBusConnection,
	address: string,
): result<string> {
	const objects = attempt(() =>
		connection.call_sync(
			"org.bluez",
			"/",
			"org.freedesktop.DBus.ObjectManager",
			"GetManagedObjects",
			null,
			null,
			Gio.DBusCallFlags.NONE,
			call_timeout_ms,
			null,
		),
	)
	if (!objects.ok) return objects
	const wanted = address.toUpperCase()
	const managed = objects.value.get_child_value(0)
	for (let index = 0; index < managed.n_children(); index++) {
		const path = String(
			managed.get_child_value(index).get_child_value(0).get_string()[0],
		)
		if (address_from_path(path) === wanted) return ok(path)
	}
	return err(new Error(`No bluez device for ${address}`))
}

export function pair_device(address: string): Promise<result<void>> {
	return new Promise((resolve) => {
		const connection = bus
		if (!connection) {
			resolve(err(new Error("Bluetooth agent is not registered")))
			return
		}
		const path = device_path(connection, address)
		if (!path.ok) {
			resolve(path)
			return
		}
		expect_pairing(address)
		connection.call(
			"org.bluez",
			path.value,
			"org.bluez.Device1",
			"Pair",
			null,
			null,
			Gio.DBusCallFlags.NONE,
			pair_timeout_ms,
			null,
			(_source, finished) => {
				forget_pairing()
				resolve(
					attempt(() => {
						connection.call_finish(finished)
					}),
				)
			},
		)
	})
}

function already_paired(device_path: string) {
	if (!bus) return false
	const paired = attempt(() =>
		bus!
			.call_sync(
				"org.bluez",
				device_path,
				"org.freedesktop.DBus.Properties",
				"Get",
				new GLib.Variant("(ss)", ["org.bluez.Device1", "Paired"]),
				null,
				Gio.DBusCallFlags.NONE,
				call_timeout_ms,
				null,
			)
			.get_child_value(0)
			.get_variant()
			.get_boolean(),
	)
	return paired.ok && paired.value
}

function reject(invocation: Gio.DBusMethodInvocation, reason: string) {
	invocation.return_dbus_error("org.bluez.Error.Rejected", reason)
}

function finish_prompt(value: GLib.Variant | null) {
	const invocation = pending_invocation
	pending_invocation = null
	set_prompt(null)
	if (!invocation) return
	if (value) invocation.return_value(value)
	else reject(invocation, "Dismissed by the user")
}

export function answer_prompt(value: string) {
	const current = prompt.peek()
	if (!current) return
	if (current.kind === "confirm" || current.kind === "display") {
		finish_prompt(null_variant())
		return
	}
	if (current.kind === "passkey") {
		const parsed = Number.parseInt(value, 10)
		if (!Number.isInteger(parsed) || parsed < 0) {
			finish_prompt(null)
			return
		}
		finish_prompt(new GLib.Variant("(u)", [parsed]))
		return
	}
	finish_prompt(new GLib.Variant("(s)", [value]))
}

export function dismiss_prompt() {
	forget_pairing()
	finish_prompt(null)
}

function null_variant() {
	return new GLib.Variant("()", [])
}

function ask(
	invocation: Gio.DBusMethodInvocation,
	device_path: string,
	next: agent_prompt,
) {
	if (!initiated_by_user(device_path)) {
		reject(invocation, "No pairing was started from the shell")
		return
	}
	finish_prompt(null)
	pending_invocation = invocation
	set_prompt(next)
}

function passkey_text(passkey: number) {
	return String(passkey).padStart(6, "0")
}

function handle(
	method: string,
	params: GLib.Variant,
	invocation: Gio.DBusMethodInvocation,
) {
	if (method === "Release" || method === "Cancel") {
		forget_pairing()
		finish_prompt(null)
		invocation.return_value(null)
		return
	}
	const device_path = String(params.get_child_value(0).get_string()[0])

	if (method === "AuthorizeService") {
		if (!initiated_by_user(device_path) && !already_paired(device_path)) {
			reject(invocation, "Device is not paired")
			return
		}
		invocation.return_value(null)
		return
	}
	if (method === "RequestAuthorization") {
		if (!initiated_by_user(device_path)) {
			reject(invocation, "No pairing was started from the shell")
			return
		}
		invocation.return_value(null)
		return
	}
	if (method === "RequestConfirmation") {
		const passkey = params.get_child_value(1).get_uint32()
		ask(invocation, device_path, {
			kind: "confirm",
			device: address_from_path(device_path),
			passkey: passkey_text(passkey),
		})
		return
	}
	if (method === "DisplayPasskey") {
		const passkey = params.get_child_value(1).get_uint32()
		ask(invocation, device_path, {
			kind: "display",
			device: address_from_path(device_path),
			passkey: passkey_text(passkey),
		})
		return
	}
	if (method === "DisplayPinCode") {
		const pin = String(params.get_child_value(1).get_string()[0])
		ask(invocation, device_path, {
			kind: "display",
			device: address_from_path(device_path),
			passkey: pin,
		})
		return
	}
	if (method === "RequestPasskey") {
		ask(invocation, device_path, {
			kind: "passkey",
			device: address_from_path(device_path),
		})
		return
	}
	if (method === "RequestPinCode") {
		ask(invocation, device_path, {
			kind: "pin",
			device: address_from_path(device_path),
		})
		return
	}
	reject(invocation, `Unsupported agent method: ${method}`)
}

function call_manager(
	connection: Gio.DBusConnection,
	method: string,
	params: GLib.Variant,
): result<void> {
	return attempt(() => {
		connection.call_sync(
			"org.bluez",
			"/org/bluez",
			"org.bluez.AgentManager1",
			method,
			params,
			null,
			Gio.DBusCallFlags.NONE,
			call_timeout_ms,
			null,
		)
	})
}

function export_agent(connection: Gio.DBusConnection): result<number> {
	const info = attempt(
		() => Gio.DBusNodeInfo.new_for_xml(interface_xml).interfaces[0],
	)
	if (!info.ok) return info
	return attempt(() =>
		connection.register_object(
			agent_path,
			info.value,
			(_connection, _sender, _path, _iface, method, params, invocation) =>
				handle(method, params, invocation),
			null,
			null,
		),
	)
}

export function stop_bluetooth_agent() {
	finish_prompt(null)
	const connection = bus
	const id = registration
	bus = null
	registration = 0
	if (!connection || !id) return
	log_error(
		call_manager(
			connection,
			"UnregisterAgent",
			new GLib.Variant("(o)", [agent_path]),
		),
		"bluetooth.agent: Failed to unregister",
	)
	log_error(
		attempt(() => connection.unregister_object(id)),
		"bluetooth.agent: Failed to unexport",
	)
}

export function start_bluetooth_agent(): result<void> {
	if (registration) return ok(undefined)
	const connection = attempt(() => Gio.bus_get_sync(Gio.BusType.SYSTEM, null))
	if (!connection.ok) return connection
	const exported = export_agent(connection.value)
	if (!exported.ok) return exported
	if (!exported.value) return err(new Error("Agent object was not exported"))

	const registered = call_manager(
		connection.value,
		"RegisterAgent",
		new GLib.Variant("(os)", [agent_path, agent_capability]),
	)
	if (!registered.ok) {
		log_error(
			attempt(() => connection.value.unregister_object(exported.value)),
			"bluetooth.agent: Failed to unexport",
		)
		return registered
	}

	bus = connection.value
	registration = exported.value
	log_error(
		call_manager(
			connection.value,
			"RequestDefaultAgent",
			new GLib.Variant("(o)", [agent_path]),
		),
		"bluetooth.agent: Failed to become the default agent",
	)
	return ok(undefined)
}

app.connect("shutdown", stop_bluetooth_agent)
