import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { capture_log, on_shutdown, tick, variant } from "../helpers.ts"

const agent_path = "/io/Astal/ags2shell/bluetooth/agent"

function reply(value: unknown) {
	return {
		n_children: () => (value as unknown[]).length,
		get_child_value: (index: number) => reply((value as unknown[])[index]),
		get_string: () => [String(value)],
		get_uint32: () => Number(value),
		get_boolean: () => Boolean(value),
		get_variant: () => reply(value),
	}
}

function device_path(address: string) {
	return `/org/bluez/hci0/dev_${address.replaceAll(":", "_")}`
}

type fixture_options = {
	no_bus?: boolean
	register_fails?: boolean
	default_fails?: boolean
	devices?: string[]
	paired?: string[]
}

async function fixture(options: fixture_options = {}) {
	const devices = options.devices ?? ["AA:BB:CC:DD:EE:FF"]
	const paired = new Set(options.paired ?? [])
	const calls: string[][] = []
	const pair_calls: string[][] = []
	const replies: unknown[] = []
	const shutdowns: (() => void)[] = []
	const errors: unknown[][] = []
	const unexported: number[] = []
	let handler: ((...args: unknown[]) => void) | null = null
	let finish_pair: ((error: Error | null) => void) | null = null
	let pair_error: Error | null = null
	let state: unknown = null
	const connection = {
		register_object: (path: string, info: string, callback) => {
			assert.equal(path, agent_path)
			assert.equal(info, "agent-info")
			handler = callback
			return 7
		},
		unregister_object: (id: number) => unexported.push(id),
		call_sync: (_name, path: string, _iface, method: string, params) => {
			calls.push([method, path])
			if (method === "RegisterAgent" && options.register_fails)
				throw new Error("already registered")
			if (method === "RequestDefaultAgent" && options.default_fails)
				throw new Error("another agent is default")
			if (method === "GetManagedObjects")
				return reply([devices.map((address) => [device_path(address), []])])
			if (method === "Get") {
				const address = devices.find(
					(candidate) => device_path(candidate) === path,
				)
				return reply([paired.has(address ?? "")])
			}
			assert.ok(params instanceof variant)
			return reply([])
		},
		call: (_name, path: string, _iface, method: string, ...rest) => {
			pair_calls.push([method, path])
			const callback = rest.at(-1) as (source, finished: string) => void
			finish_pair = (error) => {
				pair_error = error
				callback(null, "pair-reply")
			}
		},
		call_finish: (finished: string) => {
			assert.equal(finished, "pair-reply")
			if (pair_error) throw pair_error
		},
	}
	const original_error = console.error
	console.error = capture_log(errors)
	const agent = await load_module("service/bluetooth_agent.ts", {
		ags: {
			createState: (initial: unknown) => {
				state = initial
				return [
					{ peek: () => state },
					(next: unknown) => {
						state = next
					},
				]
			},
		},
		"gi://Gio": {
			default: {
				bus_get_sync: () => {
					if (options.no_bus) throw new Error("no system bus")
					return connection
				},
				BusType: { SYSTEM: 1 },
				DBusCallFlags: { NONE: 0 },
				DBusNodeInfo: {
					new_for_xml: () => ({ interfaces: ["agent-info"] }),
				},
			},
		},
		"gi://GLib": { default: { Variant: variant } },
		"$lib/app": { default: { connect: on_shutdown(shutdowns) } },
	}).finally(() => {
		console.error = original_error
	})
	return {
		agent,
		calls,
		pair_calls,
		replies,
		shutdowns,
		errors,
		unexported,
		prompt: () => state,
		finish_pair: async (error: Error | null = null) => {
			assert.ok(finish_pair, "no pairing is in flight")
			finish_pair(error)
			await tick()
		},
		invoke: (method: string, args: unknown[] = []) => {
			assert.ok(handler, "the agent was never exported")
			replies.length = 0
			handler(null, "", "", "", method, reply(args), {
				return_value: (value: unknown) => replies.push(value),
				return_dbus_error: (name: string, message: string) =>
					replies.push([name, message]),
			})
			return replies[0]
		},
		quietly: (run: () => void) => {
			console.error = capture_log(errors)
			try {
				run()
			} finally {
				console.error = original_error
			}
		},
	}
}

test("starting the agent exports it and asks bluez to make it the default", async () => {
	const f = await fixture()
	assert.deepEqual(f.agent.start_bluetooth_agent(), {
		ok: true,
		value: undefined,
	})
	assert.deepEqual(
		f.calls.map((call) => call[0]),
		["RegisterAgent", "RequestDefaultAgent"],
	)
	assert.deepEqual(f.agent.start_bluetooth_agent(), {
		ok: true,
		value: undefined,
	})
	assert.equal(f.calls.length, 2)
})

test("failing to become the default agent is logged and still starts", async () => {
	const f = await fixture({ default_fails: true })
	f.quietly(() => {
		assert.deepEqual(f.agent.start_bluetooth_agent(), {
			ok: true,
			value: undefined,
		})
	})
	assert.equal(
		f.errors[0][0],
		"bluetooth.agent: Failed to become the default agent",
	)
	assert.equal(String(f.errors[0][1]), "Error: another agent is default")
	assert.equal(f.invoke("Cancel"), null)
})

test("a bus that cannot be reached leaves nothing exported", async () => {
	const f = await fixture({ no_bus: true })
	const started = f.agent.start_bluetooth_agent()
	assert.equal(started.ok, false)
	assert.deepEqual(f.calls, [])
	assert.deepEqual(f.unexported, [])
})

test("a rejected registration unexports the agent and reports why", async () => {
	const f = await fixture({ register_fails: true })
	const started = f.agent.start_bluetooth_agent()
	assert.equal(started.ok, false)
	assert.equal(String(started.err), "Error: already registered")
	assert.deepEqual(f.unexported, [7])
})

test("stopping the agent unregisters it and unexports the object", async () => {
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	f.calls.length = 0
	f.agent.stop_bluetooth_agent()
	assert.deepEqual(
		f.calls.map((call) => call[0]),
		["UnregisterAgent"],
	)
	assert.deepEqual(f.unexported, [7])
	f.agent.stop_bluetooth_agent()
	assert.equal(f.calls.length, 1)
})

test("the agent stops on app shutdown", async () => {
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	assert.equal(f.shutdowns.length, 1)
	f.shutdowns[0]()
	assert.deepEqual(f.unexported, [7])
})

test("services are authorized for paired devices and refused for strangers", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture({ paired: [address] })
	f.agent.start_bluetooth_agent()
	assert.equal(
		f.invoke("AuthorizeService", [device_path(address), "uuid"]),
		null,
	)

	const stranger = await fixture({ devices: ["11:22:33:44:55:66"] })
	stranger.agent.start_bluetooth_agent()
	assert.deepEqual(
		stranger.invoke("AuthorizeService", [
			device_path("11:22:33:44:55:66"),
			"uuid",
		]),
		["org.bluez.Error.Rejected", "Device is not paired"],
	)
})

test("authorization and prompts are refused unless the shell started the pairing", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	const rejected = [
		"org.bluez.Error.Rejected",
		"No pairing was started from the shell",
	]
	assert.deepEqual(
		f.invoke("RequestAuthorization", [device_path(address)]),
		rejected,
	)
	assert.deepEqual(f.invoke("RequestPinCode", [device_path(address)]), rejected)
	assert.deepEqual(f.invoke("RequestPasskey", [device_path(address)]), rejected)
	assert.deepEqual(
		f.invoke("RequestConfirmation", [device_path(address), 1234]),
		rejected,
	)
	assert.equal(f.prompt(), null)
})

test("pairing a device looks up its object path and calls Pair on it", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	const paired = f.agent.pair_device(address.toLowerCase())
	assert.deepEqual(f.pair_calls, [["Pair", device_path(address)]])
	assert.equal(f.invoke("RequestAuthorization", [device_path(address)]), null)
	await f.finish_pair()
	assert.deepEqual(await paired, { ok: true, value: undefined })
})

test("a failed Pair resolves with the bluez error and drops the expectation", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	const paired = f.agent.pair_device(address)
	const failure = new Error("AuthenticationFailed")
	await f.finish_pair(failure)
	const result = await paired
	assert.equal(result.ok, false)
	assert.equal(result.err, failure)
	assert.deepEqual(f.invoke("RequestAuthorization", [device_path(address)]), [
		"org.bluez.Error.Rejected",
		"No pairing was started from the shell",
	])
})

test("pairing fails when the agent is not registered or bluez has no such device", async () => {
	const f = await fixture()
	const unregistered = await f.agent.pair_device("AA:BB:CC:DD:EE:FF")
	assert.equal(unregistered.ok, false)
	assert.equal(
		String(unregistered.err),
		"Error: Bluetooth agent is not registered",
	)

	f.agent.start_bluetooth_agent()
	const missing = await f.agent.pair_device("11:22:33:44:55:66")
	assert.equal(missing.ok, false)
	assert.equal(
		String(missing.err),
		"Error: No bluez device for 11:22:33:44:55:66",
	)
	assert.deepEqual(f.pair_calls, [])
})

test("a confirmation prompt is shown with a padded passkey and answered in place", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	void f.agent.pair_device(address)
	f.invoke("RequestConfirmation", [device_path(address), 42])
	assert.deepEqual(f.prompt(), {
		kind: "confirm",
		device: address,
		passkey: "000042",
	})
	assert.deepEqual(f.replies, [])
	f.agent.answer_prompt("")
	assert.equal(f.prompt(), null)
	assert.ok(f.replies[0] instanceof variant)
	await f.finish_pair()
})

test("displayed passkeys and pin codes are shown and acknowledged", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	void f.agent.pair_device(address)
	f.invoke("DisplayPasskey", [device_path(address), 7, 0])
	assert.deepEqual(f.prompt(), {
		kind: "display",
		device: address,
		passkey: "000007",
	})
	f.invoke("DisplayPinCode", [device_path(address), "4812"])
	assert.deepEqual(f.prompt(), {
		kind: "display",
		device: address,
		passkey: "4812",
	})
	f.agent.answer_prompt("")
	assert.equal(f.prompt(), null)
	await f.finish_pair()
})

test("a requested passkey is returned as a number and nonsense is refused", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	void f.agent.pair_device(address)
	f.invoke("RequestPasskey", [device_path(address)])
	assert.deepEqual(f.prompt(), { kind: "passkey", device: address })
	f.agent.answer_prompt("123456")
	assert.deepEqual(f.replies[0], new variant("(u)", [123456]))

	f.invoke("RequestPasskey", [device_path(address)])
	f.agent.answer_prompt("not a passkey")
	assert.deepEqual(f.replies[0], [
		"org.bluez.Error.Rejected",
		"Dismissed by the user",
	])
	await f.finish_pair()
})

test("a requested pin code is returned as text", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	void f.agent.pair_device(address)
	f.invoke("RequestPinCode", [device_path(address)])
	assert.deepEqual(f.prompt(), { kind: "pin", device: address })
	f.agent.answer_prompt("0000")
	assert.deepEqual(f.replies[0], new variant("(s)", ["0000"]))
	await f.finish_pair()
})

test("dismissing a prompt rejects the pending question and stops auto-accepting", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	void f.agent.pair_device(address)
	f.invoke("RequestPinCode", [device_path(address)])
	f.agent.dismiss_prompt()
	assert.equal(f.prompt(), null)
	assert.deepEqual(f.replies[0], [
		"org.bluez.Error.Rejected",
		"Dismissed by the user",
	])
	assert.deepEqual(f.invoke("RequestAuthorization", [device_path(address)]), [
		"org.bluez.Error.Rejected",
		"No pairing was started from the shell",
	])
	f.agent.dismiss_prompt()
	assert.equal(f.prompt(), null)
	await f.finish_pair()
})

test("Cancel and Release clear the prompt and the pairing expectation", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	for (const method of ["Cancel", "Release"]) {
		const f = await fixture()
		f.agent.start_bluetooth_agent()
		void f.agent.pair_device(address)
		f.invoke("RequestPinCode", [device_path(address)])
		f.invoke(method)
		assert.deepEqual(f.replies, [
			["org.bluez.Error.Rejected", "Dismissed by the user"],
			null,
		])
		assert.equal(f.prompt(), null)
		assert.deepEqual(f.invoke("RequestAuthorization", [device_path(address)]), [
			"org.bluez.Error.Rejected",
			"No pairing was started from the shell",
		])
		await f.finish_pair()
	}
})

test("a second prompt replaces the first and rejects it", async () => {
	const address = "AA:BB:CC:DD:EE:FF"
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	void f.agent.pair_device(address)
	f.invoke("RequestPinCode", [device_path(address)])
	f.invoke("RequestPasskey", [device_path(address)])
	assert.deepEqual(f.replies, [
		["org.bluez.Error.Rejected", "Dismissed by the user"],
	])
	assert.deepEqual(f.prompt(), { kind: "passkey", device: address })
	await f.finish_pair()
})

test("an unknown agent method is refused", async () => {
	const f = await fixture()
	f.agent.start_bluetooth_agent()
	assert.deepEqual(f.invoke("RequestUnknown", ["/org/bluez/hci0/dev_AA"]), [
		"org.bluez.Error.Rejected",
		"Unsupported agent method: RequestUnknown",
	])
})
