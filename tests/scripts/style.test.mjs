import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"

const source = stripTypeScriptTypes(
	readFileSync(new URL("../../style/runtime-css.ts", import.meta.url), "utf8"),
	{ mode: "transform" },
)

const opt = (value) => ({ peek: () => value })
const colors = {
	bg: opt("#171717"),
	fg: opt("#eeeeee"),
	widget: opt("#eeeeee"),
	border: opt("#9a9996"),
	primary: { bg: opt("#51a4e7"), fg: opt("#141414") },
	error: { bg: opt("#e55f86") },
}

async function runtime_css(widget_opacity, border_opacity) {
	const options = {
		scale: opt(100),
		font: opt("Sans 11"),
		transition: { duration: opt(200) },
		bar: { corners: opt(50) },
		hyprland: { gaps: opt(2.4) },
		theme: {
			scheme: opt("dark"),
			dark: colors,
			light: colors,
			opacity: opt(30),
			widget: { opacity: opt(widget_opacity) },
			border: { opacity: opt(border_opacity), width: opt(1) },
			shadows: opt(false),
			neumorphic: opt(false),
			padding: opt(8),
			spacing: opt(6),
			roundness: opt(12),
		},
	}
	const context = createContext({ console })
	const modules = {
		"gi://Pango": {
			default: {
				SCALE: 1024,
				FontDescription: {
					from_string: () => ({
						get_size: () => 11 * 1024,
						get_family: () => "Sans",
					}),
				},
			},
		},
		"$lib/ui": { read_value: (value) => value.peek() },
		"$shell/options": { default: options },
	}
	const entry = new SourceTextModule(source, { context })
	await entry.link(
		(name) =>
			new SyntheticModule(
				Object.keys(modules[name]),
				function () {
					for (const [key, value] of Object.entries(modules[name]))
						this.setExport(key, value)
				},
				{ context },
			),
	)
	await entry.evaluate()
	return entry.namespace.build_runtime_css()
}

test("stored widget and border opacity retain their existing inverted meaning", async () => {
	const defaults = await runtime_css(94, 86)
	assert.match(
		defaults,
		/--widget-bg: color-mix\(in srgb, #eeeeee 6%, transparent\)/,
	)
	assert.match(
		defaults,
		/--border-color: color-mix\(in srgb, #9a9996 14%, transparent\)/,
	)
	const opaque = await runtime_css(0, 0)
	assert.match(
		opaque,
		/--widget-bg: color-mix\(in srgb, #eeeeee 100%, transparent\)/,
	)
	assert.match(
		opaque,
		/--border-color: color-mix\(in srgb, #9a9996 100%, transparent\)/,
	)
})
