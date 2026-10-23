import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"
import ts from "../typescript.ts"

type FakeCopy = { content: unknown; finish: () => void }

async function color_picker_fixture(
	history,
	max = 100,
	copy_successful = true,
) {
	const copies: FakeCopy[] = []
	const notifications: unknown[] = []
	const writes: string[][] = []
	let colors
	const accessor = (
		get: () => any,
		subscribe: (fn: () => void) => () => unknown = () => () => {},
	) =>
		Object.assign(() => get(), {
			peek: get,
			subscribe,
			as: (fn) => accessor(() => fn(get())),
		})
	const make = (type, props = {}) => ({ type, props })
	const imports = {
		ags: {
			createState: (initial) => {
				let value = initial
				const listeners = new Set<() => void>()
				colors = accessor(
					() => value,
					(fn) => {
						listeners.add(fn)
						return () => listeners.delete(fn)
					},
				)
				return [
					colors,
					(next) => {
						value = next
						for (const fn of listeners) fn()
					},
				]
			},
			For: () => null,
			onCleanup: () => {},
		},
		"ags/file": {
			readFile: () => JSON.stringify(history),
			writeFileAsync: async (_path, data) => {
				writes.push(JSON.parse(data))
			},
		},
		"ags/gtk4": {
			Gdk: { BUTTON_SECONDARY: 3 },
			Gtk: {
				PositionType: { BOTTOM: 1, TOP: 2 },
				Orientation: { VERTICAL: 1 },
				GestureClick: "gesture",
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"ags/process": { execAsync: async () => "#abcdef" },
		"gi://Gio": {
			default: {
				File: {
					new_for_path: () => ({
						query_exists: () => true,
						query_info: () => ({ get_size: () => 5000 }),
					}),
				},
				FileQueryInfoFlags: { NONE: 0 },
			},
		},
		"$lib/env": { default: { paths: { cache: { base: "/cache" } } } },
		"$lib/files": { ensure_file: () => ({ ok: true }) },
		"$lib/clipboard": {
			copy_to_clipboard: (content: unknown) =>
				new Promise((resolve) =>
					copies.push({
						content,
						finish: () =>
							resolve(
								copy_successful
									? { ok: true, value: undefined }
									: { ok: false, err: new Error("wl-copy failed") },
							),
					}),
				),
		},
		"$lib/icons": { default: { ui: { colorpicker: "colorpicker" } } },
		"$lib/result": {
			attempt: (fn) => {
				try {
					return { ok: true, value: fn() }
				} catch (err) {
					return { ok: false, err }
				}
			},
			attempt_async: async (fn) => {
				try {
					return { ok: true, value: await fn() }
				} catch (err) {
					return { ok: false, err }
				}
			},
			log_error: (result) => result.ok,
			unwrap_or: (result, fallback) => (result.ok ? result.value : fallback),
		},
		"$lib/time": {
			idle: () => ({ cancel() {} }),
			timeout: () => ({ cancel() {} }),
			debounce: (_delay, fn) => ({
				call: () => {
					void fn()
				},
			}),
		},
		"$lib/notifications": {
			notify: async (value) => {
				notifications.push(value)
				return { ok: true, value: 1 }
			},
			notify_missing_programs: () => true,
		},
		"../PanelButton": { PanelButton: (props) => make("panel-button", props) },
		"widget/shared/AnimatedPopover": {
			create_animated_popover: () => ({
				popover: {
					set_focusable() {},
					set_position() {},
					set_parent() {},
					unparent() {},
				},
				revealer: { set_focusable() {}, set_child() {} },
				dispose() {},
			}),
		},
		"$shell/options": {
			default: {
				bar: { position: accessor(() => "top-center") },
				colorpicker: { maxColors: accessor(() => max) },
			},
		},
	}
	const source = readFileSync(
		new URL(
			"../../widget/Bar/components/Buttons/ColorPicker.tsx",
			import.meta.url,
		),
		"utf8",
	)
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
			jsxImportSource: "ags/gtk4",
		},
	}).outputText
	const module = new SourceTextModule(compiled)
	await module.link((name) => {
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name]))
				this.setExport(key, value)
		})
	})
	await module.evaluate()
	return {
		button: (module.namespace as { ColorPicker: () => any }).ColorPicker(),
		colors,
		copies,
		notifications,
		writes,
	}
}

test("history with 80 colors remains intact with maxColors 100 and grows on a new pick", async () => {
	const history = Array.from(
		{ length: 80 },
		(_value, i) => `#${i.toString(16).padStart(6, "0")}`,
	)
	const fixture = await color_picker_fixture(history)
	assert.deepEqual([...fixture.colors.peek()], history)
	assert.equal(fixture.writes.length, 0)
	fixture.button.props.onClicked()
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(fixture.copies.length, 1)
	assert.equal(fixture.copies[0].content, "#abcdef")
	assert.equal(fixture.notifications.length, 0)
	fixture.copies[0].finish()
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(fixture.colors.peek().length, 81)
	assert.deepEqual([...fixture.colors.peek()].slice(0, 80), history)
	assert.equal(fixture.colors.peek()[80], "#abcdef")
	assert.equal(fixture.writes[0].length, 81)
	assert.equal(fixture.notifications.length, 1)
})

test("failed clipboard parent exit does not save or notify", async () => {
	const fixture = await color_picker_fixture([], 100, false)
	fixture.button.props.onClicked()
	await new Promise((resolve) => setImmediate(resolve))
	fixture.copies[0].finish()
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual([...fixture.colors.peek()], [])
	assert.equal(fixture.writes.length, 0)
	assert.equal(fixture.notifications.length, 0)
})
