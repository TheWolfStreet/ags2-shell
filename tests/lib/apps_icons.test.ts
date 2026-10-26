import assert from "node:assert/strict"
import test from "node:test"
import { with_hyprland_command } from "../helpers.ts"
import { load_module } from "../load_module.ts"

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
	const module = await load_module("lib/apps.ts", {
		"gi://AstalApps": { default: {} },
		"gi://GioUnix": { default: {} },
		"gi://GLib": { default: {} },
		"$lib/hyprland": with_hyprland_command({ hyprland: {} }),
	})
	return module.match_client_app
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

test("title fallback accepts every separator on either side and skips short names", async () => {
	const match = await matcher()
	const krita = application("krita.desktop", "Krita", null, null, "krita")
	const vim = application("vim.desktop", "Vim", null, null, "vim")
	const apps = [vim, krita]
	const window = (title: string, initial_title = "") => ({
		class: null,
		initialClass: undefined,
		title,
		initialTitle: initial_title,
	})
	for (const title of [
		"art.kra - Krita",
		"Krita | art.kra",
		"art.kra — Krita",
		"  KRITA  ",
	])
		assert.equal(match(apps, window(title)), krita, title)
	assert.equal(match(apps, window("Krita: art")), null)
	assert.equal(match(apps, window("Vim")), null)
	assert.equal(match(apps, window("", "Krita — art")), krita)
	const by_entry = application("org.Tool.desktop", "Tool", "", "", "tool")
	assert.equal(
		match([by_entry], {
			class: "org.tool.desktop",
			initialClass: "",
			title: "",
			initialTitle: "",
		}),
		by_entry,
	)
})
