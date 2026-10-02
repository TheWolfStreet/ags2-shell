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
				for (const { event, callback } of handlers.values())
					if (event === "notify::reveal-child") callback()
				if (duration.peek() === 0) node.finish()
			}
			node.finish = () => {
				if (revealed === target) return
				revealed = target
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
		"gi://AstalApps": { default: {} },
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
		set_duration,
		rows, window, launched,
		run_idle: () => {
			for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback()
		},
		settle: () => {
			for (let i = 0; i < 3; i++) for (const row of rows.values()) row.finish()
		},
		visible: () => [...rows.values()].filter(row => row.get_reveal_child()),
		order: () => {
			const result_box = [...rows.values()][0].parent
			return result_box.children.filter(child => child.type === "revealer" && child.get_reveal_child())
			},
		label: row => row.children[0].children[1].children[0].children[2].props.label.peek(),
		icon: row => row.children[0].children[1].children[0].children[0].props.icon.peek(),
		cleanup: () => { for (const fn of cleanups) fn() },
	}
}

test("mapped rows leave, permute, re-enter and preserve desktop identity", async () => {
	const f = await launcher_fixture()
	const [a, b, c] = [...f.rows.values()]
	assert.equal(f.icon(a), "")
	f.query("a")
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "c.desktop", "b.desktop"])
	assert.deepEqual([a, c, b].map(f.label), ["󰘳 1", "󰘳 2", "󰘳 3"])
	f.settle()
	assert.equal(f.icon(a), "old")
	f.query("b")
	assert.equal(a.get_reveal_child(), false)
	assert.equal(b.get_reveal_child(), false)
	assert.deepEqual(f.order().map(row => row.props.name), [])
	f.settle()
	assert.deepEqual(f.order().map(row => row.props.name), ["b.desktop", "a.desktop", "c.desktop"])
	assert.deepEqual([b, a, c].map(f.label), ["󰘳 1", "󰘳 2", "󰘳 3"])
	f.window.props.onKey(null, 1, 0, 8)
	assert.equal(f.launched[0].get_entry(), "b.desktop")
	assert.equal(f.rows.size, 3)
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
	f.set_catalog([replacement, f.apps("d.desktop", "Ac")])
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
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "d.desktop"])
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
	assert.deepEqual(f.order().map(row => row.props.name), ["b.desktop", "a.desktop", "c.desktop"])
	assert.equal(f.visible().length, 3)
	f.query("ab")
	assert.deepEqual(f.order().map(row => row.props.name), ["a.desktop", "c.desktop"])
	f.cleanup()
})
