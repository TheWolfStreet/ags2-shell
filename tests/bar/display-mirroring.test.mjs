import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(
	execFileSync("which", ["tsc"], { encoding: "utf8" }).trim(),
)
const ts = createRequire(tsc_path)(
	"../lib/node_modules/typescript/lib/typescript.js",
)
const tick = () => new Promise((resolve) => setImmediate(resolve))

test("externally mirrored target can be unmirrored without a saved snapshot", async () => {
	const target = {
		name: "DP-1",
		model: "External",
		disabled: false,
		mirrorOf: "eDP-1",
		width: 2560,
		height: 1440,
		refreshRate: 60,
		x: 2560,
		y: 120,
		scale: 1.5,
		transform: 1,
	}
	const panel = {
		...target,
		name: "eDP-1",
		model: "Panel",
		mirrorOf: "none",
		x: 0,
		y: 0,
	}
	const messages = []
	const reads = []
	const accessor = (get) =>
		Object.assign(() => get(), {
			peek: get,
			as: (fn) => accessor(() => fn(get())),
		})
	const make = (type, props = {}) =>
		typeof type === "function"
			? type(props)
			: {
					type,
					props,
					children: (Array.isArray(props.children)
						? props.children
						: [props.children]
					).filter(Boolean),
				}
	const opened = accessor(() => "mirror-selector")
	opened.subscribe = () => () => {}
	const imports = {
		"ags/gtk4": {
			Gtk: {
				Orientation: { VERTICAL: 1 },
				Align: { CENTER: 1 },
				PolicyType: { NEVER: 1 },
				ScrolledWindow: "scroll",
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"ags/process": {
			execAsync: async (args) => {
				reads.push(args)
				return JSON.stringify([panel, target])
			},
		},
		ags: {
			createState: (initial) => {
				let state = initial
				return [
					accessor(() => state),
					(next) => {
						state = next
					},
				]
			},
			onCleanup: () => {},
			For: (props) => make("for", props),
		},
		"widget/shared/Placeholder": {
			Placeholder: (props) => make("placeholder", props),
		},
		"./MenuControls": {
			ToggleButton: (props) => make("toggle", props),
			Menu: (props) => make("menu", props),
			quick_settings_submenu: { opened, toggle() {} },
		},
		"$lib/icons": {
			default: { ui: { projector: "projector" }, missing: "missing" },
		},
		"$lib/result": {
			attempt_async: async (fn) => {
				try {
					return { ok: true, value: await fn() }
				} catch (err) {
					return { ok: false, err }
				}
			},
		},
		"$lib/hyprland": {
			hyprland: {
				focusedMonitor: panel,
				connect: () => 1,
				disconnect() {},
				message_async: async (command) => {
					messages.push(command)
					return "ok"
				},
			},
		},
		"$service/monitorConfiguration": {
			format_monitor_command: (monitor, change) => {
				const mirror =
					change.mirror && change.mirror !== "none"
						? `,mirror,${change.mirror}`
						: ""
				return `keyword monitor ${monitor.name},${monitor.width}x${monitor.height}@${monitor.refreshRate},${monitor.x}x${monitor.y},${monitor.scale},transform,${monitor.transform}${mirror}`
			},
		},
		"$shell/options": {
			default: { transition: { duration: 0 }, scale: accessor(() => 100) },
		},
	}
	const source = readFileSync(
		new URL(
			"../../widget/Bar/components/QuickSettings/components/DisplayMirroring.tsx",
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
	const root = module.namespace.DisplayMirroring.Selector()
	await tick()
	const nodes = (node) =>
		!node
			? []
			: Array.isArray(node)
				? node.flatMap(nodes)
				: node.type === "for"
					? node.props.each().map(node.props.children).flatMap(nodes)
					: node.children
						? [node, ...node.children.flatMap(nodes)]
						: []
	const button = nodes(root).find((node) => node.type === "button")
	assert.ok(button)
	assert.notEqual(button.props.sensitive, false)
	button.props.onClicked()
	await tick()
	assert.deepEqual(reads, [
		["hyprctl", "monitors", "all", "-j"],
		["hyprctl", "monitors", "all", "-j"],
		["hyprctl", "monitors", "all", "-j"],
	])
	assert.deepEqual(messages, [
		"keyword monitor DP-1,2560x1440@60,2560x120,1.5,transform,1",
	])
})
