import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"

async function fixture({ css_exists = true } = {}) {
	const events: string[] = []
	const sources: (() => boolean)[] = []
	const subscribers: (() => void)[] = []
	let watcher: (file: string) => void = () => {}
	let runtime_css = "a"
	let next_provider = 0
	class CssProvider {
		id = ++next_provider
		load_from_path(path: string) {
			events.push(`load ${this.id} ${path}`)
		}
		load_from_string(css: string) {
			events.push(`string ${this.id} ${css}`)
		}
	}
	const imports = {
		"ags/gtk4": {
			Gtk: {
				CssProvider,
				STYLE_PROVIDER_PRIORITY_APPLICATION: 600,
				StyleContext: {
					add_provider_for_display: (_display, provider, priority) =>
						events.push(`add ${provider.id} ${priority}`),
					remove_provider_for_display: (_display, provider) =>
						events.push(`remove ${provider.id}`),
				},
			},
			Gdk: { Display: { get_default: () => ({}) } },
		},
		"ags/file": {
			monitorFile: (directory: string, callback: (file: string) => void) => {
				events.push(`watch ${directory}`)
				watcher = callback
			},
		},
		"gi://GLib": {
			default: {
				PRIORITY_DEFAULT: 0,
				SOURCE_REMOVE: false,
				getenv: () => "/styles",
				build_filenamev: (parts: string[]) => parts.join("/"),
				path_get_dirname: (path: string) =>
					path.slice(0, path.lastIndexOf("/")),
				timeout_add: (_priority, _delay, callback: () => boolean) => {
					sources.push(callback)
					return sources.length
				},
			},
		},
		"$lib/env": { default: { paths: { cfg: "/cfg" } } },
		"$lib/files": { file_exists: () => css_exists },
		"$shell/options": {
			default: {},
			subscribe_options: (_options, prefixes: string[], callback) => {
				events.push(`subscribe ${prefixes.join(",")}`)
				subscribers.push(callback)
			},
		},
		"./runtime_css": { build_runtime_css: () => runtime_css },
	}
	const module = await load_module("style/index.ts", imports)
	return {
		module,
		events,
		sources,
		change_option: () => subscribers.forEach((callback) => callback()),
		touch: (file: string) => watcher(file),
		set_runtime_css(css: string) {
			runtime_css = css
		},
		run_sources() {
			while (sources.length) assert.equal(sources.shift()!(), false)
		},
	}
}

const css_path = "/styles/style/compile/main.css"

test("init loads the static sheet, the runtime sheet and watches for rebuilds", async () => {
	const state = await fixture()
	state.module.init_css()
	assert.deepEqual(state.events, [
		"add 1 600",
		`load 1 ${css_path}`,
		"subscribe scale,font,theme,bar.corners,hyprland.gaps,transition.duration",
		"string 2 a",
		"add 2 600",
		"watch /styles/style/compile",
	])
})

test("option changes coalesce and only new CSS replaces the runtime provider", async () => {
	const state = await fixture()
	state.module.init_css()
	state.events.length = 0
	state.change_option()
	state.change_option()
	assert.equal(state.sources.length, 1)
	state.run_sources()
	assert.deepEqual(state.events, [])
	state.set_runtime_css("b")
	state.change_option()
	state.run_sources()
	assert.deepEqual(state.events, ["string 3 b", "remove 2", "add 3 600"])
})

test("batches defer the reset until the outermost batch ends", async () => {
	const state = await fixture()
	state.module.init_css()
	state.module.end_css_batch()
	state.module.begin_css_batch()
	state.module.begin_css_batch()
	state.change_option()
	state.module.end_css_batch()
	assert.equal(state.sources.length, 0)
	state.module.end_css_batch()
	assert.equal(state.sources.length, 1)
	state.module.end_css_batch()
	state.run_sources()
	state.module.begin_css_batch()
	state.module.end_css_batch()
	assert.equal(state.sources.length, 0)
})

test("a rebuilt main.css reloads the static sheet; other files are ignored", async () => {
	const state = await fixture()
	state.module.init_css()
	state.events.length = 0
	state.touch("/styles/style/compile/other.css")
	assert.deepEqual(state.events, [])
	state.touch(css_path)
	assert.deepEqual(state.events, [`load 1 ${css_path}`])
	assert.equal(state.sources.length, 1)
})

test("a missing stylesheet is reported and nothing is loaded", async (t) => {
	const error = t.mock.method(console, "error", () => {})
	const state = await fixture({ css_exists: false })
	state.module.init_css()
	assert.deepEqual(
		error.mock.calls.map((call) => call.arguments),
		[[`style.reset: CSS file not found: ${css_path}`]],
	)
	assert.deepEqual(state.events, [
		"add 1 600",
		"subscribe scale,font,theme,bar.corners,hyprland.gaps,transition.duration",
		"watch /styles/style/compile",
	])
})
