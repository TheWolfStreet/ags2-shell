import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc)("../lib/node_modules/typescript/lib/typescript.js")
const source = readFileSync(new URL("../../widget/Dock/components/Trash.tsx", import.meta.url), "utf8")
const compiled = ts.transpileModule(`${source}\nexport { open_or_focus_trash }`, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText

async function fixture({ id = "org.gnome.Nautilus.desktop", executable = "/usr/bin/nautilus",
	wm_class = "Nautilus", clients = [], focused_workspace = 3, launch_result = true } = {}) {
	const calls = []
	const hyprland = { clients, focusedWorkspace: focused_workspace == null ? null : { id: focused_workspace } }
	const app = id || executable ? { get_id: () => id, get_executable: () => executable } : null
	let move = async (workspace, client) => {
		calls.push(["move", workspace, client.get_address()])
		return { ok: true, value: undefined }
	}
	const result = {
		attempt: (fn) => { try { return { ok: true, value: fn() } } catch (err) { return { ok: false, err } } },
		err: (err) => ({ ok: false, err }), ok: (value) => ({ ok: true, value }),
		log_error: (value) => { if (!value.ok) calls.push(["error", value.err]); return value.ok },
	}
	const imports = {
		ags: { createState: (value) => [() => value, () => {}] },
		"gi://Gio": { default: { AppInfo: { get_default_for_type: (type, must_support_uris) => {
			calls.push(["default", type, must_support_uris]); return app
		} }, app_info_launch_default_for_uri: (uri) => { calls.push(["launch", uri]); return launch_result } } },
		"gi://GioUnix": { default: { DesktopAppInfo: { new: () => ({ get_startup_wm_class: () => wm_class }) } } },
		"gi://GLib": { default: {} },
		"$lib/hyprland": { hyprland },
		"$lib/result": result,
		"$lib/time": { debounce: () => ({ call: () => {}, cancel: () => {} }) },
		"$lib/windowing": { get_client_workspace_id: (client) => client.workspace?.id ?? null,
			move_client_to_workspace_silent: (...args) => move(...args) },
	}
	const module = new SourceTextModule(compiled)
	await module.link((name) => {
		assert.ok(imports[name], `missing mock ${name}`)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name])) this.setExport(key, value)
		})
	})
	await module.evaluate()
	return { calls, open: module.namespace.open_or_focus_trash, click: module.namespace.open_trash,
		set_move: (fn) => { move = fn } }
}

function client(title, class_name, workspace = 2) {
	let address = "abc"
	let focuses = 0
	return { get_title: () => title, get_class: () => class_name,
		workspace: { id: workspace }, get_address: () => address,
		set_address: (value) => { address = value }, focus: () => { focuses++ },
		focuses: () => focuses }
}

test("browser tab titled Trash is never moved or focused", async () => {
	const browser = client("Trash", "firefox")
	const f = await fixture({ clients: [browser] })
	assert.equal((await f.open()).ok, true)
	assert.deepEqual(f.calls.at(-1), ["launch", "trash:///"])
	assert.equal(browser.focuses(), 0)
})

test("default Nautilus Trash window moves to focused workspace before focusing", async () => {
	const window = client("Trash", "org.gnome.Nautilus")
	const f = await fixture({ clients: [window] })
	assert.equal((await f.open()).ok, true)
	assert.deepEqual(f.calls.slice(1), [["move", 3, "abc"]])
	assert.equal(window.focuses(), 1)
})

test("StartupWMClass and executable basename identify the selected file manager", async () => {
	for (const [id, executable, wm_class, class_name] of [
		["org.kde.dolphin.desktop", "/usr/bin/dolphin", "dolphin", "dolphin"],
		[null, "/usr/bin/nautilus", null, "nautilus"],
	]) {
		const window = client("Trash", class_name)
		const f = await fixture({ id, executable, wm_class, clients: [window] })
		assert.equal((await f.open()).ok, true)
		assert.equal(window.focuses(), 1)
		assert.deepEqual(f.calls.at(-1), ["move", 3, "abc"])
		assert.equal(f.calls.some(([kind]) => kind === "launch"), false)
	}
})

test("partial title and unmatched manager do not reuse a folder window", async () => {
	const folder = client("Trash project", "org.gnome.Nautilus")
	const other = client("Trash", "dolphin")
	const f = await fixture({ clients: [folder, other] })
	assert.equal((await f.open()).ok, true)
	assert.deepEqual(f.calls.at(-1), ["launch", "trash:///"])
	assert.equal(folder.focuses() + other.focuses(), 0)
})

test("missing identity or focused workspace falls back without moving a client", async () => {
	const window = client("Trash", "Nautilus")
	const missing = await fixture({ id: null, executable: null, clients: [window] })
	assert.equal((await missing.open()).ok, true)
	assert.deepEqual(missing.calls.at(-1), ["launch", "trash:///"])
	const no_workspace = await fixture({ clients: [window], focused_workspace: null })
	assert.equal((await no_workspace.open()).ok, true)
	assert.equal(no_workspace.calls.some(([kind]) => kind === "move"), false)
	assert.deepEqual(no_workspace.calls.at(-1), ["launch", "trash:///"])
	assert.equal(window.focuses(), 0)
})

test("awaits a dynamic-address move result before focusing and reports failure", async () => {
	const window = client("Trash", "Nautilus")
	const f = await fixture({ clients: [window] })
	let finish_move
	f.set_move(async (workspace, target) => {
		f.calls.push(["move", workspace, target.get_address()])
		return new Promise((resolve) => { finish_move = resolve })
	})
	window.set_address("new-address")
	const pending = f.open()
	assert.deepEqual(f.calls.at(-1), ["move", 3, "new-address"])
	assert.equal(window.focuses(), 0)
	finish_move({ ok: false, err: new Error("move rejected") })
	assert.equal((await pending).ok, false)
	assert.equal(window.focuses(), 0)
})

test("click remains fire-and-forget and logs launch failure", async () => {
	const f = await fixture({ launch_result: false })
	assert.equal(f.click(), undefined)
	await new Promise(setImmediate)
	assert.deepEqual(f.calls.at(-1)[0], "error")
	assert.match(f.calls.at(-1)[1].message, /No application could open Trash/)
})
