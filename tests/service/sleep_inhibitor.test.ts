import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"

type fixture_options = {
	call_fails?: boolean
	finish_fails?: boolean
	no_fd?: boolean
	close_fails?: boolean
}

async function fixture(options: fixture_options = {}) {
	const calls: unknown[][] = []
	const callbacks: ((connection: unknown, response: unknown) => void)[] = []
	const closed: number[] = []
	const errors: unknown[][] = []
	let inhibited = false
	let shutdown = () => {}
	const connection = {
		call_with_unix_fd_list_finish: (response) => {
			if (options.finish_fails) throw new Error("denied")
			return [
				{ deep_unpack: () => [0] },
				{ steal_fds: () => (options.no_fd ? [] : [response]) },
			]
		},
	}
	const imports = {
		ags: {
			createState: (initial: boolean) => {
				inhibited = initial
				return [
					() => inhibited,
					(next: boolean) => {
						inhibited = next
					},
				]
			},
		},
		"gi://Gio": {
			default: {
				DBus: {
					system: {
						call_with_unix_fd_list: (...args) => {
							if (options.call_fails) throw new Error("no bus")
							calls.push(args.slice(0, 4))
							callbacks.push(args.at(-1))
						},
					},
				},
				DBusCallFlags: { NONE: 0 },
			},
		},
		"gi://GioUnix": {
			default: {
				InputStream: class {
					fd: number
					constructor({ fd }: { fd: number }) {
						this.fd = fd
					}
					close() {
						if (options.close_fails) throw new Error("busy")
						closed.push(this.fd)
					}
				},
			},
		},
		"gi://GLib": {
			default: { Variant: class {}, VariantType: class {} },
		},
		"$lib/app": {
			default: {
				connect: (signal: string, callback: () => void) => {
					assert.equal(signal, "shutdown")
					shutdown = callback
				},
			},
		},
		"$lib/env": { default: { app_name: "ags2-shell" } },
	}
	const original_error = console.error
	console.error = (...args) => errors.push(args)
	const { sleep_inhibitor } = await load_module(
		"service/sleep_inhibitor.ts",
		imports,
	).finally(() => {
		console.error = original_error
	})
	function quietly(run: () => void) {
		console.error = (...args) => errors.push(args)
		try {
			run()
		} finally {
			console.error = original_error
		}
	}
	return {
		toggle: () => quietly(sleep_inhibitor.toggle),
		inhibited: () => sleep_inhibitor.inhibited(),
		respond: (fd: number) => quietly(() => callbacks.shift()!(connection, fd)),
		shutdown: () => quietly(shutdown),
		calls,
		closed,
		errors,
	}
}

test("toggling takes a logind lock and toggling again closes it", async () => {
	const state = await fixture()
	state.toggle()
	assert.deepEqual(state.calls, [
		[
			"org.freedesktop.login1",
			"/org/freedesktop/login1",
			"org.freedesktop.login1.Manager",
			"Inhibit",
		],
	])
	assert.equal(state.inhibited(), false)
	state.toggle()
	assert.equal(state.calls.length, 1)
	state.respond(7)
	assert.equal(state.inhibited(), true)
	state.toggle()
	assert.equal(state.inhibited(), false)
	assert.deepEqual(state.closed, [7])
	assert.deepEqual(state.errors, [])
})

test("a failed logind call is logged and a later toggle retries", async () => {
	const state = await fixture({ call_fails: true })
	state.toggle()
	assert.equal(state.errors.length, 1)
	assert.equal(
		state.errors[0][0],
		"sleep_inhibitor.acquire: Failed to call logind",
	)
	assert.equal((state.errors[0][1] as Error).message, "no bus")
	state.toggle()
	assert.equal(state.errors.length, 2)
	assert.equal(state.inhibited(), false)
})

test("a refused inhibit is logged, leaves sleep allowed and can be retried", async () => {
	const state = await fixture({ finish_fails: true })
	state.toggle()
	state.respond(3)
	assert.equal(state.inhibited(), false)
	assert.equal(state.errors.length, 1)
	assert.equal(
		state.errors[0][0],
		"sleep_inhibitor.acquire: Failed to inhibit sleep",
	)
	assert.equal((state.errors[0][1] as Error).message, "denied")
	state.toggle()
	assert.equal(state.calls.length, 2)
})

test("a reply without a descriptor is reported as a missing lock", async () => {
	const state = await fixture({ no_fd: true })
	state.toggle()
	state.respond(3)
	assert.equal(state.inhibited(), false)
	assert.equal((state.errors[0][1] as Error).message, "logind returned no lock")
})

test("a lock that fails to close still clears the inhibited state", async () => {
	const state = await fixture({ close_fails: true })
	state.toggle()
	state.respond(5)
	state.toggle()
	assert.equal(state.inhibited(), false)
	assert.equal(
		state.errors[0][0],
		"sleep_inhibitor.release: Failed to close inhibitor lock",
	)
	state.toggle()
	assert.equal(state.calls.length, 2)
})

test("shell shutdown releases a held lock", async () => {
	const state = await fixture()
	state.toggle()
	state.respond(9)
	state.shutdown()
	assert.equal(state.inhibited(), false)
	assert.deepEqual(state.closed, [9])
})
