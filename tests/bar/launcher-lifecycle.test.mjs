import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")

async function launcher_fixture(bottom = false) {
	const listeners = new Set()
	const mounts = []
	const cleanups = []
	const timers = []
	const rows = new Map()
	const launched = []
	let result_reparents = 0
	let window
	let entry
	const accessor = (get, subscribe = callback => {
		listeners.add(callback)
		return () => listeners.delete(callback)
	}) => Object.assign(() => get(), {
		peek: get,
		subscribe,
		as: fn => accessor(() => fn(get()), subscribe),
	})
	const state = value => {
		const subscribers = new Set()
		return [accessor(() => value, callback => {
			subscribers.add(callback)
			return () => subscribers.delete(callback)
		}), next => {
			value = next
			for (const callback of [...subscribers]) callback()
			for (const callback of [...listeners]) callback()
		}]
	}
	const [catalog, set_catalog] = state([])
	const [favorites] = state([])
	const [max, set_max] = state(9)
	const [position, set_position] = state(bottom ? "bottom-center" : "top-center")
	const [duration, set_duration] = state(200)
	const [location] = state("launcher")
	const apps = (id, name, icon = id) => ({
		name, description: "Description", get_name: () => name,
		get_entry: () => id, get_icon_name: () => icon,
	})
	const make = (type, props = {}) => {
		if (typeof type === "function") return type(props)
		const children = Array.isArray(props.children) ? props.children : [props.children]
		const node = {
			type, props, children: children.filter(Boolean).flatMap(child => child.fragment ? child.children : [child]),
			get_name: () => props.name ?? "",
			get_first_child() { return this.children[0] ?? null },
			get_next_sibling() {
				const siblings = this.parent?.children ?? []
				return siblings[siblings.indexOf(this) + 1] ?? null
			},
			reorder_child_after(child, previous) {
				const current = this.children.indexOf(child)
				assert.notEqual(current, -1)
				this.children.splice(current, 1)
				this.children.splice(previous === null ? 0 : this.children.indexOf(previous) + 1, 0, child)
			},
		}
		for (const child of children) if (child?.fragment) child.parent = node
		for (const child of node.children) if (child?.type === "revealer") child.parent = node
		if (type === "revealer") {
			let revealed = false
			let target = false
			node.height = 0
			node.get_height = () => node.height
			node.reveal_history = []
			const handlers = new Map()
			let serial = 0
			node.connect = (event, callback) => { handlers.set(++serial, { event, callback }); return serial }
			node.disconnect = id => handlers.delete(id)
			node.get_reveal_child = () => target
			node.get_child_revealed = () => revealed
			node.get_mapped = () => true
			node.set_reveal_child = next => {
				if (target === next) return
				target = next
				node.reveal_history.push(next)
				for (const { event, callback } of handlers.values())
					if (event === "notify::reveal-child") callback()
				if (duration.peek() === 0) node.finish()
			}
			node.finish = () => {
				if (revealed === target) return
				revealed = target
				node.height = target ? 64 : 0
				for (const { event, callback } of handlers.values())
					if (event === "notify::child-revealed") callback()
			}
			node.handler_count = () => handlers.size
			if (props.$) props.$(node)
			if (node.children[0]?.children?.some(child => child?.props?.class === "app-item")) rows.set(props.name, node)
		} else if (type === "entry") {
			entry = node
			node.get_text = () => node.value ?? ""
			node.set_text = text => { node.value = text; props.onNotifyText(node) }
			node.grab_focus = () => {}
			props.$?.(node)
		} else props.$?.(node)
		return node
	}
	const imports = {
		ags: {
			createBinding: (_object, property) => property === "list" ? catalog : favorites,
			createComputed: fn => accessor(fn), createState: state,
			For: ({ each, id, children }) => {
				const fragment = { fragment: true, children: [], parent: null }
				const items = new Map()
				const update = () => {
					const next = new Map()
					for (const item of each.peek()) {
						const key = id?.(item) ?? item
						next.set(key, items.get(key) ?? children(item))
					}
					items.clear()
					for (const [key, item] of next) items.set(key, item)
					fragment.children = [...items.values()]
					if (fragment.parent) {
						if (fragment.children.some(child => child.type === "revealer")) result_reparents++
						fragment.parent.children = [...fragment.children]
						for (const child of fragment.children) child.parent = fragment.parent
					}
				}
				update()
				cleanups.push(each.subscribe(update))
				return fragment
			},
			onCleanup: fn => cleanups.push(fn), onMount: fn => mounts.push(fn),
			With: ({ value, children }) => children(value.peek()),
		},
		"ags/gtk4": {
			Astal: { Layer: { OVERLAY: 1 }, Exclusivity: { NORMAL: 1 }, Keymode: { ON_DEMAND: 1 } },
			Gtk: { RevealerTransitionType: { SLIDE_DOWN: 1, SLIDE_UP: 2 }, Orientation: { VERTICAL: 1 },
				Align: { CENTER: 1, END: 2 }, Justification: { LEFT: 1 }, Separator: props => make("separator", props) },
			Gdk: { ModifierType: { ALT_MASK: 8 }, ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`KEY_${i + 1}`, i + 1])) },
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"widget/shared/ApplicationIcon": { ApplicationIcon: props => make("icon", props) },
		"widget/shared/Placeholder": { Placeholder: props => make("placeholder", props) },
		"widget/shared/PopupWindow": { PopupWindow: props => {
			window = { ...make("window", props), visible: true, set_requested_visible() {}, hide() {} }
			props.$(window)
			return window
		} },
		"../PanelButton": { PanelButton: props => make("panel-button", props) },
		"./search": { rank_apps: (index, query, limit) => {
			const q = query.trim().toLowerCase()
			return q ? index.map(item => ({ ...item, match: item.name.indexOf(q) }))
				.filter(item => item.match >= 0)
				.sort((a, b) => a.match - b.match || a.name.localeCompare(b.name))
				.slice(0, limit).map(item => item.app) : []
		}, display_apps: (list, is_bottom) => (is_bottom ? [...list].reverse() : list)
			.map((app, rank) => ({ app, rank })) },
		"$lib/app": { default: { get_window: () => null } },
		"$lib/apps": { launch_app: app => { launched.push(app); return Promise.resolve({ ok: true }) } },
		"$lib/result": { log_error: () => {} },
		"$lib/time": { idle: callback => {
			const timer = { callback, cancelled: false, cancel() { this.cancelled = true } }
			timers.push(timer)
			return timer
		} },
		"$service/apps": { applications: {} },
		"$lib/icons": { default: { ui: { search: "search" } } },
		"$shell/options": { default: { launcher: { position, scale: accessor(() => 1), margin: accessor(() => 0),
			apps: { max } }, transition: { duration }, favorites: { location }, bar: { launcher: { icon: "icon" } } },
			surface_scale: () => 1, ui_scale: () => 1 },
	}
	const source = readFileSync(new URL("../../widget/Bar/components/Launcher/index.tsx", import.meta.url), "utf8")
	const compiled = ts.transpileModule(source, { compilerOptions: {
		module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
		jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "ags/gtk4",
	} }).outputText
	const module = new SourceTextModule(compiled)
	await module.link(name => {
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name])) this.setExport(key, value)
		})
	})
	await module.evaluate()
	set_catalog([apps("a.desktop", "Ab", "old"), apps("b.desktop", "Ba"), apps("c.desktop", "Ab")])
	module.namespace.Launcher.Window()
	for (const mount of mounts.splice(0)) mount()
	return {
		query: value => entry.set_text(value), set_catalog, set_max, set_position, apps,
		activate: () => entry.props.onActivate(),
		set_duration,
		rows, window, launched,
		result_reparents: () => result_reparents,
		run_idle: () => {
			for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback()
		},
		settle: () => {
			for (let i = 0; i < 3; i++) for (const row of rows.values()) row.finish()
		},
		visible: () => [...rows.values()].filter(row => row.get_reveal_child()),
		siblings: () => [...rows.values()][0].parent.children.filter(child => child.type === "revealer"),
		order: () => {
			const result_box = [...rows.values()][0].parent
			return result_box.children.filter(child => child.type === "revealer" && child.get_reveal_child())
			},
		label: row => row.children[0].children[1].children[0].children[2].props.label.peek(),
		title: row => row.children[0].children[1].children[0].children[1].children[0].props.label.peek(),
		icon: row => row.children[0].children[1].children[0].children[0].props.icon.peek(),
		cleanup: () => { for (const fn of cleanups) fn() },
	}
}

test("retained rows never move on rank changes and shortcuts follow visual order", async () => {
	const f = await launcher_fixture()
	const [a, b, c] = [...f.rows.values()]
	assert.equal(f.icon(a), "")
	f.query("a")
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "c.desktop", "b.desktop"])
	assert.deepEqual([a, c, b].map(f.label), ["󰘳 1", "󰘳 2", "󰘳 3"])
	f.settle()
	assert.equal(f.icon(a), "old")
	const persistent_history = [a, b, c].map(row => row.reveal_history.length)
	f.query("b")
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "c.desktop", "b.desktop"])
	for (const [index, row] of [a, b, c].entries()) {
		assert.equal(row.get_reveal_child(), true)
		assert.equal(row.get_child_revealed(), true)
		assert.deepEqual(row.reveal_history.slice(persistent_history[index]), [])
	}
	f.settle()
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "c.desktop", "b.desktop"])
	assert.deepEqual([a, c, b].map(f.label), ["󰘳 1", "󰘳 2", "󰘳 3"])
	f.window.props.onKey(null, 1, 0, 8)
	assert.equal(f.launched[0].get_entry(), "a.desktop")
	f.activate()
	assert.equal(f.launched[1].get_entry(), "a.desktop")
	assert.equal(f.rows.size, 3)
	f.query("ab")
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "c.desktop"])
	assert.equal(b.get_reveal_child(), false)
	assert.equal(b.get_child_revealed(), true)
	assert.deepEqual(f.siblings().map(row => row.props.name), ["a.desktop", "c.desktop", "b.desktop"])
	assert.deepEqual([a, c].map(row => row.reveal_history), [[true], [true]])
	f.settle()
	assert.equal(b.get_child_revealed(), false)
	f.query("b")
	assert.deepEqual(f.order().map(row => row.props.name), ["b.desktop", "a.desktop", "c.desktop"])
	assert.equal(b.get_reveal_child(), true)
	assert.equal(b.get_child_revealed(), false)
	assert.deepEqual([a, c].map(row => row.reveal_history), [[true], [true]])
	f.query("zz")
	assert.equal(f.visible().length, 0)
	f.cleanup()
	assert.deepEqual([a, b, c].map(row => row.handler_count()), [0, 0, 0])
})

test("rapid query cancellation, max changes and catalog replacement keep the query", async () => {
	const f = await launcher_fixture(true)
	const [a, b, c] = [...f.rows.values()]
	f.query("a")
	f.settle()
	f.query("b")
	f.query("a")
	f.settle()
	assert.deepEqual(f.order().map(row => row.props.name), ["b.desktop", "c.desktop", "a.desktop"])
	assert.deepEqual([b, c, a].map(f.label), ["󰘳 1", "󰘳 2", "󰘳 3"])
	f.set_max(1)
	f.settle()
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop"])
	const replacement = f.apps("a.desktop", "Ab", "new")
	const reparents = f.result_reparents()
	f.set_catalog([replacement, f.apps("d.desktop", "Ac")])
	assert.ok(f.result_reparents() > reparents)
	f.run_idle()
	f.settle()
	assert.equal(f.rows.get("a.desktop"), a)
	assert.equal(f.icon(a), "new")
	assert.equal(f.visible().length, 1)
	assert.equal(f.order()[0], a)
	f.set_max(2)
	f.settle()
	assert.equal(f.visible().length, 2)
	f.set_position("top-center")
	f.settle()
	assert.deepEqual(f.order().map(row => row.props.name), ["d.desktop", "a.desktop"])
	assert.deepEqual(f.order().map(f.label), ["󰘳 1", "󰘳 2"])
	assert.equal(a.props.transitionType.peek(), 1)
	f.cleanup()
})

test("legacy zero uses nine results and configured counts above nine are preserved", async () => {
	const f = await launcher_fixture()
	f.set_catalog(Array.from({ length: 20 }, (_, index) =>
		f.apps(`entry-${index}.desktop`, `Match ${String(index).padStart(2, "0")}`)))
	f.set_max(0)
	f.query("match")
	f.run_idle()
	f.settle()
	assert.equal(f.visible().length, 9)
	f.set_max(15)
	f.settle()
	assert.equal(f.visible().length, 15)
	assert.equal(f.label(f.order()[9]), "")
	f.cleanup()
})

test("zero-duration reshuffling keeps every matching app revealed", async () => {
	const f = await launcher_fixture()
	f.set_duration(0)
	f.query("a")
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "c.desktop", "b.desktop"])
	f.query("b")
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "c.desktop", "b.desktop"])
	assert.equal(f.visible().length, 3)
	assert.deepEqual([...f.rows.values()].map(row => row.reveal_history), [[true], [true], [true]])
	f.query("ab")
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "c.desktop"])
	f.cleanup()
})

test("an interrupted row with positive height reverses without changing siblings", async () => {
	const f = await launcher_fixture()
	f.query("a")
	f.settle()
	f.query("ab")
	const b = f.rows.get("b.desktop")
	b.height = 24
	f.query("b")
	assert.deepEqual(f.siblings().map(row => row.props.name), ["a.desktop", "c.desktop", "b.desktop"])
	assert.equal(b.get_reveal_child(), true)
	assert.deepEqual(f.order().map(f.label), ["󰘳 1", "󰘳 2", "󰘳 3"])
	f.query("ab")
	assert.deepEqual(f.siblings().map(row => row.props.name), ["a.desktop", "c.desktop", "b.desktop"])
	f.cleanup()
})

test("catalog metadata and order refresh never reparent established or closing rows", async () => {
	const f = await launcher_fixture()
	const [a, b, c] = [...f.rows.values()]
	f.query("a")
	f.settle()
	f.query("ab")
	const before = f.result_reparents()
	const order = [a, c, b]
	const replacements = [f.apps("b.desktop", "Ba", "new-b"),
		f.apps("c.desktop", "Ab", "new-c"), f.apps("a.desktop", "Ab refreshed", "new-a")]
	f.set_catalog(replacements)
	assert.deepEqual(f.siblings().map(row => row.props.name), order.map(row => row.props.name))
	assert.equal(f.result_reparents(), before)
	assert.deepEqual(f.siblings(), order)
	assert.equal(b.get_child_revealed(), true)
	assert.equal(b.get_reveal_child(), false)
	assert.equal(f.icon(a), "new-a")
	assert.equal(f.icon(c), "new-c")
	assert.equal(f.title(a), "Ab refreshed")
	assert.deepEqual(f.order().map(f.label), ["󰘳 1", "󰘳 2"])
	f.run_idle()
	assert.deepEqual(f.siblings(), order)
	assert.equal(f.result_reparents(), before)
	f.set_catalog([...replacements].reverse())
	assert.deepEqual(f.siblings(), order)
	assert.equal(f.result_reparents(), before)
	f.run_idle()
	assert.deepEqual(f.siblings(), order)
	f.activate()
	assert.equal(f.launched[0], replacements[2])
	f.window.props.onKey(null, 2, 0, 8)
	assert.equal(f.launched[1], replacements[1])
	f.cleanup()
})

test("real Gnim With does not rebuild Results for catalog metadata, but does for orientation", async () => {
	const source = readFileSync(new URL("../../widget/Bar/components/Launcher/index.tsx", import.meta.url), "utf8")
	const ast = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
	let initializer
	function visit(node) {
		if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) &&
			node.name.elements[0]?.getText(ast) === "row_ids") initializer = node.initializer.getText(ast)
		ts.forEachChild(node, visit)
	}
	visit(ast)
	assert.ok(initializer)
	assert.match(initializer, /all_apps\.peek\(\)/)
	const load = name => new SourceTextModule(ts.transpileModule(readFileSync(
		new URL(`../../node_modules/gnim/dist/jsx/${name}.ts`, import.meta.url), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
	}).outputText)
	const scope = load("scope")
	const state = load("state")
	const with_module = load("With")
	await with_module.link(name => {
		if (name === "./scope.js") return scope
		if (name === "./state.js") return state
		const exports = name === "gi://GObject"
			? { default: { Object: class { connect() {} disconnect() {} }, TYPE_JSOBJECT: 1 } }
			: name === "gi://Gio" || name === "gi://GLib" ? { default: {} }
			: name === "../util.js" ? { camelify: value => value, kebabify: value => value }
			: name === "./env.js" ? { env: { defaultCleanup() {} } }
			: name === "./Fragment.js" ? { Fragment: class {
				children = []
				append(child) { this.children.push(child) }
				remove(child) { this.children.splice(this.children.indexOf(child), 1) }
				[Symbol.iterator]() { return this.children[Symbol.iterator]() }
			} }
			: null
		assert.ok(exports, name)
		return new SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
		})
	})
	await with_module.evaluate()
	const { createState } = state.namespace
	const { createRoot } = scope.namespace
	const { With } = with_module.namespace
	function construct(expression) {
		const code = ts.transpileModule(`const [row_ids] = ${expression};`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
		}).outputText
		const make_ids = new Function("createState", "all_apps", `${code}\nreturn row_ids`)
		const [catalog, set_catalog] = createState([{ get_entry: () => "a.desktop", icon: "old" }])
		const [orientation, set_orientation] = createState(false)
		let dispose
		let fragment
		const created = []
		createRoot(cleanup => {
			dispose = cleanup
			fragment = With({ value: orientation, children: bottom => {
				const row = { ids: make_ids(createState, catalog), bottom,
					icon: () => catalog.peek()[0].icon }
				created.push(row)
				return row
			} })
		})
		const original = fragment.children[0]
		assert.deepEqual(original.ids.peek(), ["a.desktop"])
		set_catalog([{ get_entry: () => "a.desktop", icon: "new" }])
		const after_catalog = fragment.children[0]
		set_orientation(true)
		const after_orientation = fragment.children[0]
		assert.equal(after_orientation.bottom, true)
		assert.notEqual(after_orientation, after_catalog)
		assert.equal(after_orientation.icon(), "new")
		dispose()
		return { original, after_catalog, created }
	}
	const stable = construct(initializer)
	assert.equal(stable.after_catalog, stable.original)
	assert.equal(stable.after_catalog.icon(), "new")
	assert.equal(stable.created.length, 2)
	const tracked = construct(initializer.replace("all_apps.peek()", "all_apps()"))
	assert.notEqual(tracked.after_catalog, tracked.original)
	assert.equal(tracked.created.length, 3)
})
