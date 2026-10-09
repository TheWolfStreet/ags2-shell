import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(
	execFileSync("which", ["tsc"], { encoding: "utf8" }).trim(),
)
const ts = createRequire(tsc_path)(
	"../lib/node_modules/typescript/lib/typescript.js",
)
const source = readFileSync(
	new URL("../../widget/Desktop/DragAndDrop.tsx", import.meta.url),
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

async function fixture() {
	const events = []
	const cleanups = []
	const controllers = []
	const icon = { hidden: true }
	const snapshots = []
	const moves = []
	let dragging_css = false
	let selected = ["/desktop/a", "/desktop/b"]
	const state = (initial) => {
		let value = initial
		const subscribers = new Set()
		return [
			Object.assign(() => value, {
				peek: () => value,
				subscribe(callback) {
					subscribers.add(callback)
					return () => subscribers.delete(callback)
				},
			}),
			(next) => {
				value = next
				for (const callback of [...subscribers]) callback()
			},
		]
	}
	class Picture {
		constructor(props) {
			this.canTarget = props.canTarget
			this.visible = props.visible
		}
		set visible(value) {
			this.is_visible = value
			events.push(["visible", value])
		}
		get visible() {
			return this.is_visible
		}
	}
	class Fixed {
		constructor() {
			this.handlers = new Map()
		}
		put(picture, x, y) {
			this.picture = picture
			this.coordinates = [x, y]
			events.push(["put", x, y])
		}
		move(picture, x, y) {
			assert.equal(picture, this.picture)
			this.coordinates = [x, y]
			events.push(["move", x, y])
		}
		add_controller(controller) {
			this.controllers ??= []
			this.controllers.push(controller)
		}
	}
	const make_controller = () => ({
		handlers: new Map(),
		connect(name, callback) {
			this.handlers.set(name, callback)
		},
		fire(name, ...args) {
			return this.handlers.get(name)(this, ...args)
		},
		set_actions() {},
		set_icon(...args) {
			this.icon = args
			events.push(["native-icon"])
		},
		get_current_event_state: () => 0,
	})
	const gtk = {
		Widget: class {},
		Fixed,
		Picture,
		DragSource: { new: () => make_controller() },
		DropTargetAsync: { new: () => make_controller() },
		WidgetPaintable: {
			new: (widget) => ({
				get_current_image: () => ({
					get_intrinsic_width: () => widget.get_width(),
					get_intrinsic_height: () => widget.get_height(),
					snapshot: () => {
						events.push(["snapshot"])
						snapshots.push({ dragging_css })
					},
				}),
			}),
		},
		Snapshot: class {
			push_opacity() {}
			save() {}
			translate() {}
			restore() {}
			pop() {}
			to_paintable() {
				return { preview: true }
			}
		},
	}
	const imports = {
		ags: {
			createState: state,
			onCleanup: (callback) => cleanups.push(callback),
		},
		"ags/gtk4": {
			Gtk: gtk,
			Gdk: {
				DragAction: { MOVE: 1, COPY: 2 },
				ModifierType: { CONTROL_MASK: 4 },
				ContentFormats: {
					new_for_gtype: () => ({ union: () => ({}) }),
					new: () => ({}),
				},
				FileList: { $gtype: 1 },
			},
		},
		"ags/gtk4/jsx-runtime": {
			jsx: (type, props) => {
				const fixed = new type()
				props.$(fixed)
				return fixed
			},
		},
		"$lib/time": { timeout: () => ({ cancel() {} }) },
		"gi://Gio": { default: { Cancellable: class {} } },
		"gi://GLib": { default: { PRIORITY_DEFAULT: 0 } },
		"gi://Graphene": { default: { Point: class {}, Size: class {} } },
		"$lib/textures": { hidden_drag_icon: () => icon },
		"$shell/options": { default: { desktop: { enabled: () => true } } },
		"./FileOperations": {
			build_file_content_provider: (paths) => paths,
			paths_from_uris: () => [],
			read_file_text: () => "",
			split_payload_lines: () => [],
		},
		"./Desktop": {
			desktop_interaction: {
				selected: { peek: () => selected },
				select: (paths) => {
					selected = paths
				},
				press() {},
				redraw() {},
			},
			import_files_to_desktop: () => {},
			monitor_of_desktop_path: () => null,
			move_desktop_files: (move) => moves.push(move),
		},
		"./GridGeometry": { nearest_slot_index_for_point: (x, y) => [x, y] },
	}
	const module = new SourceTextModule(compiled)
	await module.link((name) => {
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name]))
				this.setExport(key, value)
		})
	})
	await module.evaluate()
	const add_monitor = (id) => {
		const drag = module.namespace.create_desktop_drag_controller({
			peek: () => ({ id, metrics: {} }),
			subscribe: () => () => {},
		})
		const target = new Fixed()
		drag.attach_target(target)
		const layer = module.namespace.DragLayer({ drag })
		const widget = {
			translate_coordinates: (anchor, _x, _y) => [
				true,
				anchor === widget ? 0 : 50,
				0,
			],
			get_width: () => 40,
			get_height: () => 30,
			add_controller: (controller) => controllers.push(controller),
		}
		drag.attach_source(widget, "/desktop/a", () => {
			dragging_css = true
		})
		return {
			drag,
			layer,
			source: controllers.at(-1),
			target: target.controllers[0],
		}
	}
	const drop = { get_actions: () => 3 }
	return {
		add_monitor,
		events,
		snapshots,
		moves,
		icon,
		drop,
		cleanups,
		set_dragging_css: (value) => {
			dragging_css = value
		},
	}
}

test("prepare snapshots before drag CSS, hides the native icon and waits for motion", async () => {
	const f = await fixture()
	const a = f.add_monitor("a")
	a.drag.track(400, 250)
	a.source.fire("prepare", 11, 7)
	assert.deepEqual(
		f.snapshots.map((item) => item.dragging_css),
		[false],
	)
	assert.deepEqual(a.source.icon, [f.icon, 0, 0])
	assert.ok(
		f.events.findIndex(([event]) => event === "native-icon") <
			f.events.findIndex(([event]) => event === "snapshot"),
	)
	assert.equal(a.layer.picture.visible, false)
	assert.equal(a.target.fire("drag-enter", f.drop, 0, 0), 1)
	assert.equal(a.layer.picture.visible, false)
	assert.equal(a.target.fire("drag-motion", f.drop, 210, 120), 1)
	assert.deepEqual(a.layer.coordinates, [199, 113])
	assert.equal(a.layer.picture.visible, true)
	assert.deepEqual(f.events.slice(-2), [
		["move", 199, 113],
		["visible", true],
	])
	for (const cleanup of f.cleanups) cleanup()
})

test("end and cancel hide the ghost without leave; a new session cannot use old coordinates", async () => {
	const f = await fixture()
	const a = f.add_monitor("a")
	a.source.fire("prepare", 9, 5)
	a.target.fire("drag-motion", f.drop, 180, 90)
	assert.equal(a.layer.picture.visible, true)
	a.source.fire("drag-end", {}, false)
	assert.equal(a.layer.picture.visible, false)
	f.set_dragging_css(false)
	a.source.fire("prepare", 9, 5)
	assert.equal(a.layer.picture.visible, false)
	a.target.fire("drag-enter", f.drop, 0, 0)
	assert.equal(a.layer.picture.visible, false)
	a.target.fire("drag-motion", f.drop, 0, 0)
	assert.deepEqual(a.layer.coordinates, [-9, -5])
	assert.equal(a.layer.picture.visible, true)
	a.source.fire("drag-cancel")
	assert.equal(a.layer.picture.visible, false)
	assert.equal(a.drag.hovered.peek(), false)
	assert.equal(a.drag.state.peek().paths.length, 2)
	f.set_dragging_css(false)
	a.source.fire("prepare", 9, 5)
	assert.equal(a.layer.picture.visible, false)
	a.target.fire("drag-enter", f.drop, 0, 0)
	assert.equal(a.layer.picture.visible, false)
	a.target.fire("drag-motion", f.drop, 75, 55)
	assert.deepEqual(a.layer.coordinates, [66, 50])
	assert.equal(a.layer.picture.visible, true)
})

test("a new drag invalidates stale hover on every monitor before publishing its preview", async () => {
	const f = await fixture()
	const a = f.add_monitor("a")
	const b = f.add_monitor("b")
	a.source.fire("prepare", 6, 4)
	b.target.fire("drag-motion", f.drop, 320, 160)
	assert.equal(b.layer.picture.visible, true)
	a.source.fire("drag-cancel")
	assert.equal(b.layer.picture.visible, false)
	assert.equal(b.drag.hovered.peek(), false)
	a.source.fire("drag-end", {}, false)
	assert.equal(b.layer.picture.visible, false)
	b.drag.track(321, 161)
	a.source.fire("prepare", 6, 4)
	assert.equal(b.drag.hovered.peek(), false)
	assert.equal(b.layer.picture.visible, false)
	b.target.fire("drag-enter", f.drop, 0, 0)
	assert.equal(b.layer.picture.visible, false)
	b.target.fire("drag-motion", f.drop, 110, 80)
	assert.deepEqual(b.layer.coordinates, [104, 76])
	assert.equal(b.layer.picture.visible, true)
})

test("enter retains cross-monitor fallback coordinates without showing the ghost", async () => {
	const f = await fixture()
	const a = f.add_monitor("a")
	const b = f.add_monitor("b")
	a.source.fire("prepare", 6, 4)
	assert.equal(b.target.fire("drag-enter", f.drop, 72, 38), 1)
	assert.equal(b.layer.picture.visible, false)
	a.source.fire("drag-end", {}, true)
	assert.deepEqual(f.moves, [
		{
			to: "b",
			paths: ["/desktop/a", "/desktop/b"],
			slot: [72, 38],
			anchor: "/desktop/a",
		},
	])
})

function available(command) {
	try {
		execFileSync("which", [command], { stdio: "ignore" })
		return true
	} catch {
		return false
	}
}

test(
	"native DragLayer first painted frame has no origin ghost and motion uses scrolled content bounds",
	{
		skip: !available("gjs") || !available("xvfb-run") || !available("ags"),
	},
	() => {
		const ast = ts.createSourceFile(
			"DragAndDrop.tsx",
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		)
		const layer = ast.statements.find(
			(node) =>
				ts.isFunctionDeclaration(node) && node.name?.text === "DragLayer",
		)
		assert.ok(layer)
		const stage = mkdtempSync(join(tmpdir(), "ags-drag-preview-"))
		try {
			const entry = join(stage, "drag-preview.tsx")
			const output = join(stage, "drag-preview")
			writeFileSync(
				entry,
				`import { createRoot, createState, onCleanup } from "ags"
import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gsk from "gi://Gsk"
const options = { desktop: { enabled: () => true } }
${layer.getText(ast)}
Gtk.init()
function check(condition, message) { if (!condition) throw new Error(message) }
function frame(window) {
	const clock = window.get_frame_clock()
	const loop = new GLib.MainLoop(null, false)
	let painted = false
	const signal = clock.connect("after-paint", () => { painted = true; loop.quit() })
	let deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { deadline = 0; loop.quit(); return GLib.SOURCE_REMOVE })
	window.queue_draw()
	loop.run()
	clock.disconnect(signal)
	if (deadline) GLib.Source.remove(deadline)
	check(painted, "native frame was not painted")
}
function bounds(child, parent) {
	const [ok, rect] = child.compute_bounds(parent)
	check(ok, "native widget has no bounds")
	return [rect.origin.x, rect.origin.y, rect.size.width, rect.size.height]
}
function nodes(widget) {
	const snapshot = new Gtk.Snapshot()
	Gtk.WidgetPaintable.new(widget).snapshot(snapshot, widget.get_width(), widget.get_height())
	const node = snapshot.to_node()
	let count = 0
	function visit(current) {
		if (!current) return
		if (current.get_node_type() === Gsk.RenderNodeType.TEXTURE_NODE) count++
		if (typeof current.get_n_children === "function")
			for (let i = 0; i < current.get_n_children(); i++) visit(current.get_child(i))
		else if (typeof current.get_child === "function") visit(current.get_child())
	}
	visit(node)
	return count
}
let dispose, set_preview, set_position, set_hovered
const layer_widget = createRoot(stop => {
	dispose = stop
	const [preview, update_preview] = createState(null)
	const [position, update_position] = createState({ x: 0, y: 0 })
	const [hovered, update_hovered] = createState(false)
	set_preview = update_preview
	set_position = update_position
	set_hovered = update_hovered
	return DragLayer({ drag: { preview, position, hovered } })
})
const window = new Gtk.Window({ defaultWidth: 360, defaultHeight: 220 })
const scroll = new Gtk.ScrolledWindow()
const overlay = new Gtk.Overlay()
const content = new Gtk.Fixed({ widthRequest: 600, heightRequest: 500 })
const source_a = new Gtk.Label({ label: "A", widthRequest: 40, heightRequest: 32 })
const source_b = new Gtk.Label({ label: "B", widthRequest: 40, heightRequest: 32 })
content.put(source_a, 100, 90)
content.put(source_b, 160, 90)
overlay.set_child(content)
overlay.add_overlay(layer_widget)
scroll.set_child(overlay)
window.set_child(scroll)
window.present()
frame(window)
scroll.get_hadjustment().set_value(80)
scroll.get_vadjustment().set_value(60)
frame(window)
const sources_before = [bounds(source_a, content), bounds(source_b, content)]
const bytes = new GLib.Bytes(new Uint8Array(40 * 32 * 4).fill(255))
const paintable = Gdk.MemoryTexture.new(40, 32, Gdk.MemoryFormat.R8G8B8A8, bytes, 40 * 4)
const ghost = { paintable, width: 40, height: 32, hotspot_x: 11, hotspot_y: 7 }
const picture = layer_widget.get_first_child()
set_preview(ghost)
frame(window)
const prepare = { visible: picture.get_visible(), nodes: nodes(layer_widget) }
set_hovered(false)
frame(window)
const enter = { visible: picture.get_visible(), nodes: nodes(layer_widget) }
set_position({ x: 210, y: 120 })
set_hovered(true)
frame(window)
const motion = { visible: picture.get_visible(), nodes: nodes(layer_widget),
	content: bounds(picture, content), window: bounds(picture, window),
	adjustment: [scroll.get_hadjustment().get_value(), scroll.get_vadjustment().get_value()] }
const sources_after = [bounds(source_a, content), bounds(source_b, content)]
set_hovered(false)
set_preview(null)
frame(window)
const end = { visible: picture.get_visible(), nodes: nodes(layer_widget) }
set_preview(ghost)
frame(window)
const restart = { visible: picture.get_visible(), nodes: nodes(layer_widget) }
set_position({ x: 0, y: 0 })
set_hovered(true)
frame(window)
const zero = { visible: picture.get_visible(), content: bounds(picture, content) }
print(JSON.stringify({ prepare, enter, motion, end, restart, zero, sources_before, sources_after }))
window.destroy()
dispose()
`,
			)
			const root = fileURLToPath(new URL("../../", import.meta.url))
			const bundle = spawnSync(
				"ags",
				["bundle", entry, output, "-g", "4", "-r", root],
				{
					encoding: "utf8",
					timeout: 60000,
				},
			)
			assert.equal(bundle.status, 0, bundle.stderr || bundle.stdout)
			const run = spawnSync("xvfb-run", ["-a", output], {
				encoding: "utf8",
				timeout: 30000,
				env: { ...process.env, GTK_A11Y: "none", XDG_RUNTIME_DIR: stage },
			})
			assert.equal(run.status, 0, run.stderr || run.error?.message)
			assert.doesNotMatch(run.stderr, /Gtk-(?:WARNING|CRITICAL)|Gjs-CRITICAL/)
			const report = JSON.parse(run.stdout.trim())
			assert.deepEqual(report.prepare, { visible: false, nodes: 0 })
			assert.deepEqual(report.enter, { visible: false, nodes: 0 })
			assert.equal(report.motion.visible, true)
			assert.ok(report.motion.nodes > 0, JSON.stringify(report))
			assert.deepEqual(report.motion.content.slice(0, 2), [199, 113])
			assert.deepEqual(report.motion.window.slice(0, 2), [119, 53])
			assert.deepEqual(report.motion.adjustment, [80, 60])
			assert.deepEqual(report.sources_after, report.sources_before)
			assert.deepEqual(report.end, { visible: false, nodes: 0 })
			assert.deepEqual(report.restart, { visible: false, nodes: 0 })
			assert.equal(report.zero.visible, true)
			assert.deepEqual(report.zero.content.slice(0, 2), [-11, -7])
			console.log(JSON.stringify(report))
		} finally {
			rmSync(stage, { recursive: true, force: true })
		}
	},
)
