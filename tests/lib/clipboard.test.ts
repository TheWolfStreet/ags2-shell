import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"

type fake_process = {
	args: string[]
	flags: number
	stdin_path: string | null
	input?: string | null
	cancelled: boolean
	forced: boolean
	finish: () => void
}

async function load({
	successful = true,
	spawn_error = null as Error | null,
	finish_error = null as Error | null,
} = {}) {
	const processes: fake_process[] = []
	const deadlines: Array<() => void> = []
	const cancelled_deadlines: number[] = []
	class SubprocessLauncher {
		flags: number
		stdin_path: string | null = null
		constructor({ flags }: { flags: number }) {
			this.flags = flags
		}
		set_stdin_file_path(path: string) {
			this.stdin_path = path
		}
		spawnv(args: string[]) {
			if (spawn_error) throw spawn_error
			const process: fake_process & Record<string, unknown> = {
				args,
				flags: this.flags,
				stdin_path: this.stdin_path,
				cancelled: false,
				forced: false,
				finish: () => {},
				force_exit() {
					this.forced = true
				},
				communicate_utf8_async(input, cancellable, callback) {
					this.input = input
					cancellable.process = this
					this.finish = () => callback(this, {})
				},
				communicate_utf8_finish() {
					if (finish_error) throw finish_error
					return [true, "", ""]
				},
				get_successful: () => successful,
			}
			processes.push(process)
			return process
		}
	}
	const imports = {
		"gi://Gio": {
			default: {
				SubprocessLauncher,
				SubprocessFlags: { NONE: 0, STDIN_PIPE: 1 },
				Cancellable: class {
					process: fake_process | null = null
					cancel() {
						if (this.process) this.process.cancelled = true
					}
				},
			},
		},
		"$lib/time": {
			timeout: (ms: number, callback: () => void) => {
				assert.equal(ms, 5000)
				const index = deadlines.push(callback) - 1
				return { cancel: () => cancelled_deadlines.push(index) }
			},
		},
	}
	const module = await load_module("lib/clipboard.ts", imports)
	return {
		copy_to_clipboard: module.copy_to_clipboard,
		processes,
		deadlines,
		cancelled_deadlines,
	}
}

test("text is piped to a detached wl-copy whose own exit decides the result", async () => {
	const { copy_to_clipboard, processes } = await load()
	const pending = copy_to_clipboard("#abcdef")
	assert.equal(processes.length, 1)
	const [copy] = processes
	assert.deepEqual(copy.args, ["setsid", "wl-copy"])
	assert.equal(copy.flags, 1)
	assert.equal(copy.input, "#abcdef")
	copy.finish()
	assert.deepEqual(await pending, { ok: true, value: undefined })
})

test("files are fed from disk with their MIME type and no forking setsid", async () => {
	const { copy_to_clipboard, processes } = await load()
	const pending = copy_to_clipboard({
		path: "/tmp/shot.png",
		mime_type: "image/png",
	})
	const [copy] = processes
	assert.deepEqual(copy.args, ["setsid", "wl-copy", "--type", "image/png"])
	assert.equal(copy.args.includes("-f"), false)
	assert.equal(copy.flags, 0)
	assert.equal(copy.stdin_path, "/tmp/shot.png")
	assert.equal(copy.input, null)
	copy.finish()
	assert.equal((await pending).ok, true)
})

test("an unsuccessful wl-copy exit is reported as a failure", async () => {
	const { copy_to_clipboard, processes } = await load({ successful: false })
	const pending = copy_to_clipboard("text")
	processes[0].finish()
	const copied = await pending
	assert.equal(copied.ok, false)
	assert.match(String(copied.err), /wl-copy failed/)
})

test("the deadline cancels the exchange and kills a hung wl-copy", async () => {
	const { copy_to_clipboard, processes, deadlines } = await load()
	void copy_to_clipboard("text")
	assert.equal(deadlines.length, 1)
	deadlines[0]()
	assert.equal(processes[0].cancelled, true)
	assert.equal(processes[0].forced, true)
})

test("a wl-copy that cannot start is reported without arming the deadline", async () => {
	const spawn_error = new Error("setsid missing")
	const { copy_to_clipboard, deadlines } = await load({ spawn_error })
	assert.deepEqual(await copy_to_clipboard("text"), {
		ok: false,
		err: spawn_error,
	})
	assert.equal(deadlines.length, 0)
})

test("a failed wl-copy exchange is reported with its cause", async () => {
	const finish_error = new Error("operation was cancelled")
	const { copy_to_clipboard, processes } = await load({ finish_error })
	const pending = copy_to_clipboard("text")
	processes[0].finish()
	assert.deepEqual(await pending, { ok: false, err: finish_error })
})

test("a finished exchange disarms its deadline before reporting", async () => {
	const { copy_to_clipboard, processes, cancelled_deadlines } = await load({
		successful: false,
	})
	const pending = copy_to_clipboard("text")
	assert.deepEqual(cancelled_deadlines, [])
	processes[0].finish()
	assert.deepEqual(cancelled_deadlines, [0])
	assert.equal((await pending).ok, false)
	assert.deepEqual(cancelled_deadlines, [0])
})
