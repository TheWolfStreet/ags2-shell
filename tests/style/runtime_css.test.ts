import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"

type settings = {
	scheme?: string
	opacity?: number
	neumorphic?: boolean
	shadows?: boolean
	scale?: number
	font?: string
}

function option<T>(value: T) {
	const read = () => value
	read.peek = () => value
	return read
}

function colors(prefix: string) {
	return {
		bg: option(`#${prefix}0000`),
		fg: option(`#${prefix}1111`),
		widget: option(`#${prefix}2222`),
		border: option(`#${prefix}3333`),
		primary: { bg: option(`#${prefix}8040`), fg: option(`#${prefix}5555`) },
		error: { bg: option(`#${prefix}6666`) },
	}
}

async function render(path: string, settings: settings = {}) {
	const options = {
		scale: option(settings.scale ?? 100),
		font: option(settings.font ?? "Sans 12"),
		transition: { duration: option(200) },
		hyprland: { gaps: option(2) },
		bar: { corners: option(50) },
		theme: {
			scheme: option(settings.scheme ?? "dark"),
			dark: colors("aa"),
			light: colors("cc"),
			opacity: option(settings.opacity ?? 30),
			widget: { opacity: option(94) },
			border: { width: option(1), opacity: option(86) },
			shadows: option(settings.shadows ?? true),
			neumorphic: option(settings.neumorphic ?? true),
			padding: option(8),
			spacing: option(6),
			roundness: option(12),
		},
	}
	const pango = {
		SCALE: 1024,
		FontDescription: {
			from_string: (font: string) => {
				const [family, size] = font.split(" ")
				return {
					get_family: () => family,
					get_size: () => Number(size) * 1024,
				}
			},
		},
	}
	const module = await load_module(path, {
		"gi://Pango": { default: pango },
		"$lib/ui": { read_value: (value: () => unknown) => value() },
		"$shell/options": { default: options },
	})
	return module
}

function css(module) {
	return module.build_runtime_css() as string
}

test("dark scheme colors, translucency and neumorphic shadows", async () => {
	const output = css(await render("style/runtime_css.ts"))
	assert.match(
		output,
		/^@define-color window_bg_color color-mix\(in srgb, #aa0000 70%, transparent\);$/m,
	)
	assert.match(output, /^--primary-bg: #aa8040;$/m)
	assert.match(
		output,
		/^--active-gradient: linear-gradient\(to right, #aa8040, #a37b3d\);$/m,
	)
	assert.match(output, /^--shadow-color: rgba\(0, 0, 0, 0.6\);$/m)
	assert.match(
		output,
		/^--neu-button-highlight: inset 0 1px 0 0 color-mix\(in srgb, white 15%, transparent\);$/m,
	)
	assert.match(
		output,
		/^--neu-trough-inset: inset 0 1px 2px 0 color-mix\(in srgb, black 15%, transparent\), inset 0 -1px 0 0 color-mix\(in srgb, white 5%, transparent\);$/m,
	)
	assert.match(
		output,
		/^--neu-slider-highlight: inset 0 1px 0 0 color-mix\(in srgb, white 30%, transparent\);$/m,
	)
	const neu = output.match(/^--neu-[a-z-]+/gm)
	assert.deepEqual(neu, [
		"--neu-button-highlight",
		"--neu-button-shadow",
		"--neu-button-hover-highlight",
		"--neu-button-hover-shadow",
		"--neu-button-active-highlight",
		"--neu-button-active-shadow",
		"--neu-widget-highlight",
		"--neu-widget-shadow",
		"--neu-trough-inset",
		"--neu-progress-highlight",
		"--neu-progress-shadow",
		"--neu-slider-highlight",
	])
})

test("light scheme halves opacity and tints shadows with the foreground", async () => {
	const output = css(await render("style/runtime_css.ts", { scheme: "light" }))
	assert.match(
		output,
		/^--bg: color-mix\(in srgb, #cc0000 85%, transparent\);$/m,
	)
	assert.match(output, /^--fg: #cc1111;$/m)
	assert.match(output, /^--error-bg: #cc6666;$/m)
	assert.match(
		output,
		/^--neu-button-shadow: 0 1px 2px 0 color-mix\(in srgb, #cc1111 14%, transparent\);$/m,
	)
	assert.match(output, /^--shadow-color: rgba\(0, 0, 0, 0.4\);$/m)
})

test("disabled effects become transparent and opaque backgrounds stay plain", async () => {
	const output = css(
		await render("style/runtime_css.ts", { neumorphic: false, opacity: 0 }),
	)
	assert.match(output, /^--bg: #aa0000;$/m)
	const neu = output.match(/^--neu-.*$/gm)!
	assert.equal(neu.length, 12)
	assert.equal(
		neu.every((line) => line.endsWith(": 0 0 0 0 transparent;")),
		true,
	)
	const flat = css(await render("style/runtime_css.ts", { shadows: false }))
	assert.match(flat, /^--shadow-color: transparent;$/m)
	assert.match(flat, /^--neu-widget-shadow: 0 0 0 0 transparent;$/m)
})

test("scale multiplies layout tokens and keeps unscaled ui copies", async () => {
	const module = await render("style/runtime_css.ts", {
		scale: 150,
		font: "Inter 10",
	})
	const output = css(module)
	for (const line of [
		"--padding: 12pt;",
		"--ui-padding: 12pt;",
		"--radius: 18px;",
		"--font-size: 15pt;",
		"--icon-size: 24px;",
		"--popover-radius: 36px;",
		"--scale: 1.5;",
		'--font-name: "Inter";',
		"--screen-corner-radius: 18px;",
		"--neu-button-shadow: 0 1.5px 3px 0 color-mix(in srgb, black 20%, transparent);",
	])
		assert.ok(output.split("\n").includes(line), line)
	assert.equal(
		module.scaled_token_overrides(2),
		"--padding: calc(var(--ui-padding) * 2);--spacing: calc(var(--ui-spacing) * 2);--radius: calc(var(--ui-radius) * 2);--border-width: calc(var(--ui-border-width) * 2);--font-size: calc(var(--ui-font-size) * 2);--icon-size: calc(var(--ui-icon-size) * 2);--popover-padding: calc(var(--ui-popover-padding) * 2);--popover-radius: calc(var(--ui-popover-radius) * 2);",
	)
})
