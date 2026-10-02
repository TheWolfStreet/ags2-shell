import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")

async function service_fixture({ copy_successful = true } = {}) {
	let resolve_pidof
	let hold_pidof = false
	const processes = []
	const commands = []
	const notifications = []
	const errors = []
	const signals = new Map()
	const imports = {
		"ags/gobject": {
			default: { Object: class { notify() {} vfunc_finalize() {} } },
			getter: () => () => {}, register: () => value => value,
		},
		"ags/process": {
			execAsync: args => {
				commands.push(args)
				if (args[0] === "pidof") return hold_pidof
					? new Promise(resolve => { resolve_pidof = resolve }) : Promise.resolve("")
				if (args[0] === "hyprctl") return Promise.resolve('[{"focused":true,"name":"DP-1"}]')
				return Promise.resolve("")
			},
			Process: class {}, subprocess: () => { throw new Error("unexpected recorder") },
		},
		"$lib/time": { interval: () => ({ cancel() {} }), timeout: () => ({ cancel() {} }) },
		"$lib/app": { default: {
			connect: (name, callback) => { signals.set(name, callback); return 1 }, disconnect() {},
		} },
		"gi://GLib": { default: {
			DateTime: { new_now_local: () => ({ format: () => "time" }) },
			uuid_string_random: () => "uuid", shell_quote: value => `'${value}'`,
		} },
		"gi://Gio": { default: {
			SubprocessFlags: { NONE: 0, STDOUT_PIPE: 1, STDERR_PIPE: 2 },
			Subprocess: { new: (args, flags) => {
				const process = {
					args, flags, waited: false, communicated: false,
					force_exit() { this.callback?.(this, {}) },
					communicate_utf8_async(_input, _cancel, callback) { this.communicated = true; this.callback = callback },
					communicate_utf8_finish() { return [true, "10,20 30x40", ""] },
					wait_check_async(_cancel, callback) { this.waited = true; queueMicrotask(() => callback(this, {})) },
					wait_check_finish() { return copy_successful },
					get_successful() { return true },
				}
				processes.push(process)
				return process
			} },
		} },
		"$lib/env": { default: { paths: { home: "/test" } } },
		"$lib/result": {
			ok: value => ({ ok: true, value }), err: err => ({ ok: false, err }),
			attempt: fn => { try { return { ok: true, value: fn() } } catch (err) { return { ok: false, err } } },
			attempt_async: async fn => { try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, err } } },
			log_error: (result, message) => { if (!result.ok) errors.push(message); return result.ok },
		},
		"$lib/files": { ensure_directory: () => ({ ok: true }) },
		"$lib/notifications": { notify: async value => { notifications.push(value); return { ok: true } }, notify_missing_programs: () => true },
		"$lib/icons": { default: { fallback: { image: "image", video: "video" } } },
	}
	const source = readFileSync(new URL("../../service/screenCapture.ts", import.meta.url), "utf8")
	const compiled = ts.transpileModule(source, { compilerOptions: {
		module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
		experimentalDecorators: true,
	} }).outputText
	const module = new SourceTextModule(compiled)
	await module.link(name => {
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name])) this.setExport(key, value)
		})
	})
	await module.evaluate()
	return {
		service: module.namespace.screen_capture, processes, commands, notifications, errors, signals,
		hold_query: () => { hold_pidof = true },
		release_query: () => resolve_pidof(""),
	}
}

test("stopping recording while pidof is pending never starts slurp", async () => {
	const fixture = await service_fixture()
	fixture.hold_query()
	const started = fixture.service.start_recording({ scope: "area" })
	assert.equal(fixture.service.stop_recording().ok, true)
	fixture.release_query()
	assert.equal((await started).value, "cancelled")
	assert.equal(fixture.processes.length, 0)
})

test("shutdown while pidof is pending cancels screenshot before selection", async () => {
	const fixture = await service_fixture()
	fixture.hold_query()
	const screenshot = fixture.service.screenshot({ scope: "area" })
	await fixture.service.shutdown()
	fixture.release_query()
	assert.equal((await screenshot).value, "cancelled")
	assert.equal(fixture.processes.length, 0)
	assert.equal(fixture.commands.some(args => args[0] === "grim"), false)
})

test("shutdown after selector spawn cancels screenshot without grim", async () => {
	const fixture = await service_fixture()
	const screenshot = fixture.service.screenshot({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(fixture.processes.length, 1)
	await fixture.service.shutdown()
	assert.equal((await screenshot).value, "cancelled")
	assert.equal(fixture.commands.some(args => args[0] === "grim"), false)
})

test("shutdown after selector spawn cancels recording", async () => {
	const fixture = await service_fixture()
	const recording = fixture.service.start_recording({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(fixture.processes.length, 1)
	await fixture.service.shutdown()
	assert.equal((await recording).value, "cancelled")
})

test("stop after selector spawn cancels recording", async () => {
	const fixture = await service_fixture()
	const recording = fixture.service.start_recording({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(fixture.processes.length, 1)
	assert.equal(fixture.service.stop_recording().ok, true)
	assert.equal((await recording).value, "cancelled")
})

test("completed area selection captures via native finish callback", async () => {
	const fixture = await service_fixture()
	const screenshot = fixture.service.screenshot({ scope: "area" })
	await Promise.resolve()
	await Promise.resolve()
	fixture.processes[0].callback(fixture.processes[0], {})
	assert.equal((await screenshot).value, "captured")
	assert.equal(fixture.commands.some(args => args[0] === "grim" && args[2] === "10,20 30x40"), true)
})

test("focused screenshot does not capture when shutdown finishes monitor query", async () => {
	const fixture = await service_fixture()
	const screenshot = fixture.service.screenshot()
	await fixture.service.shutdown()
	assert.equal((await screenshot).value, "cancelled")
	assert.equal(fixture.commands.some(args => args[0] === "grim"), false)
	assert.equal((await fixture.service.screenshot()).value, "cancelled")
})

test("screenshot detaches clipboard provider, checks parent exit, and shows concise notification", async () => {
	const fixture = await service_fixture()
	assert.equal((await fixture.service.screenshot()).value, "captured")
	const copy = fixture.processes[0]
	assert.equal(copy.args[0], "bash")
	assert.match(copy.args[2], /^setsid wl-copy --type image\/png </)
	assert.doesNotMatch(copy.args[2], /setsid -f/)
	assert.equal(copy.flags, 0)
	assert.equal(copy.waited, true)
	assert.equal(copy.communicated, false)
	assert.equal(fixture.notifications[0].body, "Saved to Pictures/Screenshots")
	assert.equal(fixture.notifications[0].preview_image, "/test/Pictures/Screenshots/time-uuid.png")
})

test("failed clipboard provider exit is reported while the saved screenshot remains available", async () => {
	const fixture = await service_fixture({ copy_successful: false })
	assert.equal((await fixture.service.screenshot()).value, "captured")
	assert.deepEqual(fixture.errors, ["screenCapture.screenshot: Saved screenshot but failed to copy it"])
	assert.equal(fixture.notifications.length, 1)
})
