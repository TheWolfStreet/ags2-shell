import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")
const path = "/home/tws/Software/Music/Prefix/icons/FL Studio 21.png"

function app(entry, name, wm_class, icon) {
	return {
		get_entry: () => entry, get_name: () => name, get_wm_class: () => wm_class,
		get_executable: () => "bottles-cli run -p 'FL Studio 21'", get_icon_name: () => icon,
	}
}

function client(class_name, initial_class, title, initial_title = "") {
	return {
		class: class_name, initialClass: initial_class, title, initialTitle: initial_title,
		address: "0x1", get_title() { return this.title }, focus() {}, kill() {},
	}
}

function nodes(tree, type) {
	if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, type))
	if (!tree || typeof tree !== "object") return []
	return [...(tree.type === type ? [tree] : []), ...tree.children.flatMap(node => nodes(node, type))]
}

async function fixture() {
	const fl = app("Music--FL Studio 21--1734389237.668505.desktop", "FL Studio 21", "FL Studio 21", path)
	const editor = app("editor.desktop", "Editor", "Editor", "editor-symbolic")
	const catalog = { list: [fl, editor], favorites: [fl] }
	const running = []
	const texture_paths = []
	const accessor = get => Object.assign(() => get(), {
		peek: get, as: fn => accessor(() => fn(get())),
	})
	const make = (type, props = {}) => {
		if (typeof type === "function") return type(props)
		return { type, props, children: (Array.isArray(props.children) ? props.children : [props.children]).filter(Boolean) }
	}
	const imports = {
		ags: {
			createBinding: (object, property) => accessor(() => object[property]),
			createComputed: fn => accessor(fn), createState: initial => [accessor(() => initial), () => {}],
			For: ({ each, children }) => each().map(children),
			With: ({ value, children }) => children(value()),
		},
		"ags/gtk4": { Gdk: { BUTTON_SECONDARY: 3, BUTTON_MIDDLE: 2 }, Gtk: {
			Align: { CENTER: 1, START: 2 }, Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
			ContentFit: { CONTAIN: 0 }, Picture: "picture", Separator: "separator", GestureClick: "gesture",
		} },
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make, Fragment: ({ children }) => children },
		"$lib/textures": { create_square_texture_accessor: (icon, size) => {
			texture_paths.push([icon, size]); return accessor(() => icon)
		} },
		"$lib/ui": { read_value: value => typeof value === "function" ? value() : value },
		"gi://GioUnix": { default: {} }, "gi://GLib": { default: {} },
		"$lib/hyprland": { hyprland: {} },
		"$lib/result": { attempt: () => {}, attempt_async: () => {}, err: () => {}, ok: () => {} },
		"$lib/windowing": {
			create_window_client_list: () => accessor(() => running),
			create_client_title_accessor: value => accessor(() => value.title),
			focused_window_client: accessor(() => null),
			focus_client_and_toggle_fullscreen: () => {}, dispatch_client_button_action: () => {},
		},
		"$shell/options": { default: {
			bar: { taskbar: { exclusive: accessor(() => false) } },
			favorites: { location: accessor(() => "dock") }, dock: { trash: accessor(() => false) },
		}, ui_scale: () => 1 },
		"$service/apps": { applications: catalog },
		"$lib/time": { timeout: () => {} },
		"$lib/icons": { default: { trash_detailed: { full: "trash", empty: "trash-empty" } } },
		"./Trash": { has_items: accessor(() => false), open_trash: () => {} },
	}
	const paths = {
		"$lib/apps": "../../lib/apps.ts",
		"widget/shared/ApplicationIcon": "../../widget/shared/ApplicationIcon.tsx",
	}
	const modules = new Map()
	async function load(file) {
		if (modules.has(file)) return modules.get(file)
		const source = readFileSync(new URL(file, import.meta.url), "utf8")
		const compiled = ts.transpileModule(source, { compilerOptions: {
			module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "ags/gtk4",
		} }).outputText
		const module = new SourceTextModule(compiled)
		modules.set(file, module)
		await module.link(async name => {
			if (paths[name]) return load(paths[name])
			assert.ok(imports[name], name)
			return new SyntheticModule(Object.keys(imports[name]), function () {
				for (const [key, value] of Object.entries(imports[name])) this.setExport(key, value)
			})
		})
		await module.evaluate()
		return module
	}
	const bar = await load("../../widget/Bar/components/Buttons/WindowList.tsx")
	const dock = await load("../../widget/Dock/components/DockItems.tsx")
	return { fl, editor, catalog, running, texture_paths, bar: bar.namespace, dock: dock.namespace,
		accessor, render_bar: () => bar.namespace.WindowList(),
		render_dock: () => {
			const items = dock.namespace.create_dock_items(accessor(() => true))()
			return { items, trees: items.map(item => dock.namespace.render_dock_item(item, "bottom", accessor(() => 64))) }
		},
	}
}

test("bar and dock render the catalog's absolute FL icon through the same picture loader", async () => {
	const f = await fixture()
	f.running.push(client("fl64.exe", "FL Studio 21", "Project.flp"))
	const bar = f.render_bar()
	const dock = f.render_dock()
	assert.equal(nodes(bar, "picture")[0].props.paintable(), path)
	assert.equal(nodes(dock.trees, "picture")[0].props.paintable(), path)
	assert.deepEqual(f.texture_paths.map(([icon, size]) => [icon, size]), [[path, 16], [path, 64]])
	assert.equal(dock.items.length, 1)
	assert.equal(dock.items[0].kind, "group")
})

test("symbolic icons use theme images; catalog reload and client metadata update both taskbars", async () => {
	const f = await fixture()
	f.catalog.favorites = []
	const window = client("Editor", "", "Editor")
	f.running.push(window)
	assert.equal(nodes(f.render_bar(), "image")[0].props.iconName, "editor-symbolic")
	assert.equal(nodes(f.render_dock().trees, "image")[0].props.iconName, "editor-symbolic")
	assert.equal(f.texture_paths.length, 0)

	window.class = "fl64.exe"
	window.initialClass = ""
	window.title = "FL Studio 21 - Project.flp"
	assert.equal(nodes(f.render_bar(), "picture")[0].props.paintable(), path)
	assert.equal(nodes(f.render_dock().trees, "picture")[0].props.paintable(), path)

	f.catalog.list = [f.editor]
	f.catalog.favorites = []
	assert.equal(nodes(f.render_bar(), "image")[0].props.iconName, "fl64.exe")
	assert.equal(nodes(f.render_dock().trees, "image")[0].props.iconName, "fl64.exe")
	window.initialClass = "Editor"
	assert.equal(nodes(f.render_bar(), "image")[0].props.iconName, "editor-symbolic")
	assert.equal(nodes(f.render_dock().trees, "image")[0].props.iconName, "editor-symbolic")
	window.class = ""
	window.initialClass = ""
	window.title = "Untitled"
	assert.equal(nodes(f.render_bar(), "image")[0].props.iconName, "application-x-executable-symbolic")
	assert.equal(nodes(f.render_dock().trees, "image")[0].props.iconName, "application-x-executable-symbolic")
})

test("classless clients resolving to the same desktop ID share a favorite group", async () => {
	const f = await fixture()
	f.running.push(client("", "FL Studio 21", "Project 1"), client("", "", "FL Studio 21 - Project 2"))
	const { items, trees } = f.render_dock()
	assert.equal(items.length, 1)
	assert.equal(items[0].kind, "group")
	assert.equal(items[0].clients.length, 2)
	assert.equal(nodes(trees, "picture")[0].props.paintable(), path)
})

test("mixed classless groups retain a generic icon and separate favorites regardless of order", async () => {
	const cases = [
		["fl", "editor", "fl"], ["editor", "fl", "fl"],
		["fl", "unknown", "fl"], ["unknown", "fl", "fl"],
	]
	for (const order of cases) {
		const f = await fixture()
		f.catalog.favorites = [f.fl, f.editor]
		const clients = {
			fl: client("", "FL Studio 21", "Project"),
			editor: client("", "Editor", "Document"),
			unknown: client("", "", "Untitled"),
		}
		f.running.push(clients[order[0]], clients[order[1]])
		for (const count of [2, 3]) {
			if (count === 3) f.running.push(client("", "FL Studio 21", "Another project"))
			const { items, trees } = f.render_dock()
			const group_index = items.findIndex(item => item.kind === "group")
			assert.equal(items.length, 3, `${order} after ${count} clients`)
			assert.equal(items[group_index].clients.length, count)
			assert.equal(items[group_index].icon, undefined)
			assert.equal(nodes(trees[group_index], "image")[0].props.iconName, "application-x-executable-symbolic")
			assert.deepEqual(items.filter(item => item.kind === "favorite").map(item => item.app.get_entry()),
				[f.fl.get_entry(), f.editor.get_entry()])
		}
	}
})
