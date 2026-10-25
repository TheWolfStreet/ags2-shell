import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"
import ts from "../typescript.ts"
import { with_hyprland_command } from "../hyprland.ts"
import * as lua from "../../lib/lua.ts"

function application(entry, name, wm_class, executable, icon) {
	return {
		get_entry: () => entry,
		get_name: () => name,
		get_wm_class: () => wm_class,
		get_executable: () => executable,
		get_icon_name: () => icon,
	}
}

async function matcher() {
	const source = readFileSync(
		new URL("../../lib/apps.ts", import.meta.url),
		"utf8",
	)
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText
	const module = new SourceTextModule(compiled)
	await module.link((name) => {
		const imports = {
			"gi://GioUnix": { default: {} },
			"gi://GLib": { default: {} },
			"$lib/hyprland": with_hyprland_command({ hyprland: {} }),
			"$lib/lua": lua,
			"$lib/result": {
				attempt: () => {},
				attempt_async: () => {},
				err: () => {},
				ok: () => {},
			},
		}
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name]))
				this.setExport(key, value)
		})
	})
	await module.evaluate()
	const namespace: Record<string, any> = module.namespace
	return namespace.match_client_app
}

test("startup class, desktop ID, executable basename, and bounded title resolve the catalog app", async () => {
	const match = await matcher()
	const path = "/home/tws/Software/Music/Prefix/icons/FL Studio 21.png"
	const fl = application(
		"Music--FL Studio 21--1734389237.668505.desktop",
		"FL Studio 21",
		"FL Studio 21",
		"bottles-cli run -p 'FL Studio 21'",
		path,
	)
	const editor = application(
		"org.example.Editor.desktop",
		"Editor",
		"Editor",
		"/usr/bin/editor %U",
		"editor-symbolic",
	)
	const apps = [editor, fl]
	assert.equal(
		match(apps, {
			class: "fl64.exe",
			initialClass: "FL Studio 21",
			title: "Project",
			initialTitle: "",
		}),
		fl,
	)
	assert.equal(
		match(apps, {
			class: "music--fl studio 21--1734389237.668505",
			initialClass: "",
			title: "",
			initialTitle: "",
		}),
		fl,
	)
	assert.equal(
		match(apps, {
			class: "editor",
			initialClass: "",
			title: "",
			initialTitle: "",
		}),
		editor,
	)
	assert.equal(
		match(apps, {
			class: "fl64.exe",
			initialClass: "",
			title: "FL Studio 21 - Project",
			initialTitle: "",
		}),
		fl,
	)
	assert.equal(
		match(apps, {
			class: "fl64.exe",
			initialClass: "",
			title: "Project",
			initialTitle: "FL Studio 21",
		}),
		fl,
	)
	assert.equal(
		match(apps, {
			class: "fl64.exe",
			initialClass: "",
			title: "Project",
			initialTitle: "",
		}),
		null,
	)
	assert.equal(
		match(apps, {
			class: "fl64.exe",
			initialClass: "",
			title: "Project 21 - Untitled",
			initialTitle: "",
		}),
		null,
	)
	assert.equal(
		match(apps, {
			class: "FL Studio 21",
			initialClass: "",
			title: "Editor",
			initialTitle: "",
		}),
		fl,
	)
	assert.equal(
		match(apps, {
			class: "fl64.exe",
			initialClass: "",
			title: "FL Studio 21",
			initialTitle: "",
		})?.get_icon_name(),
		path,
	)
})

test("title fallback rejects ambiguity and partial names", async () => {
	const match = await matcher()
	const apps = [
		application("first.desktop", "FL Studio 21", "", "bottles-cli", "first"),
		application("second.desktop", "FL Studio 21", "", "wine", "second"),
	]
	assert.equal(
		match(apps, {
			class: "fl64.exe",
			initialClass: "",
			title: "FL Studio 21",
			initialTitle: "",
		}),
		null,
	)
	assert.equal(
		match(apps, {
			class: "fl64.exe",
			initialClass: "",
			title: "FL Studio 21ish",
			initialTitle: "",
		}),
		null,
	)
})
