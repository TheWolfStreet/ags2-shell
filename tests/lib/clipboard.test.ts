import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"
import * as result from "../../lib/result.ts"

type FakeProcess = {
	args: string[]
	flags: number
	stdin_path: string | null
	input?: string | null
	cancelled: boolean
	forced: boolean
	finish: () => void
}

async function load({ successful = true } = {}) {
	const processes: FakeProcess[] = []
	const deadlines: Array<() => void> = []
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
			const process: FakeProcess & Record<string, unknown> = {
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
					process: FakeProcess | null = null
					cancel() {
						if (this.process) this.process.cancelled = true
					}
				},
			},
		},
		"$lib/result": result,
		"$lib/time": {
			timeout: (ms: number, callback: () => void) => {
				assert.equal(ms, 5000)
				deadlines.push(callback)
				return { cancel() {} }
			},
		},
	}
	const module = new SourceTextModule(
		stripTypeScriptTypes(
			readFileSync(new URL("../../lib/clipboard.ts", import.meta.url), "utf8"),
		),
	)
	await module.link((name) => {
		const exports = imports[name]
		assert.ok(exports, name)
		return new SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports))
				this.setExport(key, value)
		})
	})
	await module.evaluate()
	return {
		copy_to_clipboard: (module.namespace as Record<string, any>)
			.copy_to_clipboard,
		processes,
		deadlines,
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
