import assert from "node:assert/strict"
import test from "node:test"
import { createContext } from "node:vm"
import { with_hyprland_command } from "../hyprland.ts"
import { load_module } from "../load_module.ts"
import * as result from "../../lib/result.ts"
import { tick } from "../helpers.ts"

type option = {
	id: string
	peek(): unknown
	set(value: unknown): void
	subscribe(callback: () => void): () => void
}

function options_tree(sets: string[]) {
	const subscribers = new Map<string, (() => void)[]>()
	function option(id: string, initial: unknown): option {
		let value = initial
		return {
			id,
			peek: () => value,
			set(next) {
				value = next
				sets.push(`${id}=${next}`)
				for (const callback of subscribers.get(id) ?? []) callback()
			},
			subscribe(callback) {
				subscribers.set(id, [...(subscribers.get(id) ?? []), callback])
				return () => {}
			},
		}
	}
	function colors(scheme: string, primary: string) {
		return {
			bg: option(`theme.${scheme}.bg`, "#000000"),
			fg: option(`theme.${scheme}.fg`, "#000000"),
			widget: option(`theme.${scheme}.widget`, "#000000"),
			border: option(`theme.${scheme}.border`, "#000000"),
			primary: {
				bg: option(`theme.${scheme}.primary.bg`, primary),
				fg: option(`theme.${scheme}.primary.fg`, "#000000"),
			},
			error: { bg: option(`theme.${scheme}.error.bg`, "#000000") },
		}
	}
	return {
		autotheme: option("autotheme", false),
		tmux: { accent: option("tmux.accent", true) },
		hyprland: {
			gaps: option("hyprland.gaps", 2.4),
			inactiveBorder: option("hyprland.inactiveBorder", "#282828"),
		},
		theme: {
			scheme: option("theme.scheme", "dark"),
			dark: colors("dark", "#51a4e7"),
			light: colors("light", "#426ede"),
			spacing: option("theme.spacing", 6),
			roundness: option("theme.roundness", 12),
			border: { width: option("theme.border.width", 1) },
			blur: option("theme.blur", false),
			shadows: option("theme.shadows", true),
		},
	}
}

async function fixture({
	tmux = true,
	themes = [] as string[],
	icon_theme = "",
	failing = [] as string[],
	sessions = "main\nwork\n",
	autotheme = false,
} = {}) {
	const commands: string[][] = []
	const settings: string[] = []
	const messages: string[] = []
	const sets: string[] = []
	const css: string[] = []
	const options = options_tree(sets)
	options.autotheme.set(autotheme)
	sets.length = 0
	let current_icon_theme = icon_theme
	let color_scheme = "prefer-light"
	const imports = {
		"ags/process": {
			execAsync: async (args: string[]) => {
				commands.push(args)
				if (failing.includes(args[1]) || failing.includes(args[3]))
					throw new Error(`${args[1]} failed`)
				if (args[1] === "list-sessions") return sessions
				return ""
			},
		},
		"gi://Gio": {
			default: {
				Settings: class {
					get_string(key: string) {
						return key === "icon-theme" ? current_icon_theme : color_scheme
					}
					set_string(key: string, value: string) {
						settings.push(`${key}=${value}`)
						if (key === "icon-theme") current_icon_theme = value
						else color_scheme = value
					}
				},
			},
		},
		"gi://GdkPixbuf": {
			default: {
				Pixbuf: {
					get_file_info: () => [{}, 10, 10],
					new_from_file_at_scale: () => ({
						get_pixels: () => new Uint8Array([10, 20, 30]),
						get_width: () => 1,
						get_height: () => 1,
						get_rowstride: () => 3,
						get_n_channels: () => 3,
						get_has_alpha: () => false,
					}),
				},
			},
		},
		"gi://GLib": {
			default: {
				find_program_in_path: (name: string) =>
					name === "tmux" && tmux ? name : null,
				build_filenamev: (parts: string[]) => parts.join("/"),
				get_home_dir: () => "/home",
				get_user_data_dir: () => "/home/.local/share",
				get_system_data_dirs: () => ["/usr/share"],
				file_test: (path: string) =>
					themes.some(
						(theme) => path === `/usr/share/icons/${theme}/index.theme`,
					),
				FileTest: { EXISTS: 1 },
			},
		},
		style: {
			init_css: () => css.push("init"),
			begin_css_batch: () => css.push("begin"),
			end_css_batch: () => css.push("end"),
		},
		"$lib/colors": {
			build_wallpaper_palette: () => ({
				dark: palette("d"),
				light: palette("l"),
			}),
		},
		"$lib/env": { default: { init: () => result.ok(undefined) } },
		"$lib/time": {
			debounce: (_ms: number, fn: () => unknown) => ({
				call: fn,
				cancel() {},
			}),
		},
		"$lib/textures": { get_file_size: () => 1 },
		"$lib/files": {
			max_image_bytes: 2,
			valid_image_dimensions: () => true,
		},
		"$lib/hyprland": with_hyprland_command({
			hyprland: {
				connect() {},
				message_async: async (message: string) => {
					messages.push(message)
					return "ok"
				},
			},
		}),
		"$lib/wallpaper": {
			wallpaper_path: "/wall",
			wallpaper_revision: { peek: () => 1, subscribe() {} },
		},
		"$shell/options": {
			default: options,
			subscribe_options: () => () => {},
		},
	}
	const module = await load_module("shell/startup.ts", imports)
	return { module, options, commands, settings, messages, sets, css }
}

function palette(prefix: string) {
	return {
		bg: `${prefix}bg`,
		fg: `${prefix}fg`,
		widget: `${prefix}widget`,
		border: `${prefix}border`,
		primary_bg: `${prefix}primary_bg`,
		primary_fg: `${prefix}primary_fg`,
		error_bg: `${prefix}error_bg`,
	}
}

test("tmux accent sync sets the global and every session accent in order", async () => {
	const state = await fixture()
	assert.equal(state.module.default().ok, true)
	await tick()
	assert.deepEqual(state.commands, [
		["tmux", "set", "-g", "@main_accent", "#51a4e7"],
		["tmux", "list-sessions", "-F", "#S"],
		["tmux", "set-option", "-t", "main", "@main_accent", "#51a4e7"],
		["tmux", "set-option", "-t", "work", "@main_accent", "#51a4e7"],
	])
})

test("tmux failures are debug notes and never stop the remaining sessions", async (t) => {
	const debug = t.mock.method(console, "debug", () => {})
	const error = t.mock.method(console, "error", () => {})
	const state = await fixture({ failing: ["set", "main"] })
	state.module.default()
	await tick()
	assert.equal(state.commands.length, 4)
	assert.deepEqual(
		debug.mock.calls.map((call) => [
			call.arguments[0],
			(call.arguments[1] as Error).message,
		]),
		[
			["startup.tmux: Accent sync skipped", "set failed"],
			[
				"startup.tmux: Accent sync skipped for session main",
				"set-option failed",
			],
		],
	)
	assert.equal(error.mock.calls.length, 0)
})

test("missing tmux sessions end the sync after the global accent", async (t) => {
	const debug = t.mock.method(console, "debug", () => {})
	const error = t.mock.method(console, "error", () => {})
	const state = await fixture({ failing: ["list-sessions"] })
	state.module.default()
	await tick()
	assert.equal(state.commands.length, 2)
	assert.equal(error.mock.calls.length, 0)
	assert.equal(
		debug.mock.calls[0].arguments[0],
		"startup.tmux: No tmux sessions to sync",
	)
	const empty = await fixture({ sessions: "" })
	empty.module.default()
	await tick()
	assert.equal(empty.commands.length, 2)
})

test("tmux sync follows the accent toggle and the active scheme", async () => {
	const state = await fixture()
	state.options.tmux.accent.set(false)
	state.module.default()
	await tick()
	assert.deepEqual(state.commands, [])
	state.options.tmux.accent.set(true)
	await tick()
	state.commands.length = 0
	state.options.theme.scheme.set("light")
	await tick()
	assert.deepEqual(state.commands[0], [
		"tmux",
		"set",
		"-g",
		"@main_accent",
		"#426ede",
	])
	const absent = await fixture({ tmux: false })
	absent.module.default()
	await tick()
	assert.deepEqual(absent.commands, [])
})

test("the icon theme follows the scheme through its dark and light variants", async () => {
	const dark = await fixture({
		icon_theme: "Papirus",
		themes: ["Papirus", "Papirus-Dark"],
	})
	dark.module.default()
	assert.deepEqual(dark.settings, [
		"color-scheme=prefer-dark",
		"icon-theme=Papirus-Dark",
	])
	dark.options.theme.scheme.set("light")
	assert.deepEqual(dark.settings.slice(2), [
		"color-scheme=prefer-light",
		"icon-theme=Papirus",
	])
	const light_variant = await fixture({
		icon_theme: "Adwaita_dark",
		themes: ["Adwaita_light", "Adwaita"],
	})
	light_variant.options.theme.scheme.set("light")
	light_variant.module.default()
	assert.deepEqual(light_variant.settings, ["icon-theme=Adwaita_light"])
	const current = await fixture({
		icon_theme: "Papirus-Dark",
		themes: ["Papirus-Dark"],
	})
	current.module.default()
	assert.deepEqual(current.settings, ["color-scheme=prefer-dark"])
	const missing = await fixture({ icon_theme: "Custom", themes: [] })
	missing.module.default()
	assert.deepEqual(missing.settings, ["color-scheme=prefer-dark"])
	const unset = await fixture({ themes: ["-Dark"] })
	unset.module.default()
	assert.deepEqual(unset.settings, ["color-scheme=prefer-dark"])
})

test("hyprland appearance renders spacing, borders and effects as one Lua config", async () => {
	const state = await fixture({ tmux: false })
	state.module.default()
	await tick()
	assert.deepEqual(state.messages, [
		'eval hl.config({ general = { border_size = 1, gaps_out = 14, gaps_in = 7, col = { active_border = "rgba(51a4e7ff)", inactive_border = "rgba(282828ff)" } }, decoration = { rounding = 12, shadow = { enabled = true }, blur = { enabled = false } } })',
	])
})

test("a hyprland appearance that cannot be built is logged", async (t) => {
	const error = t.mock.method(console, "error", () => {})
	const state = await fixture({ tmux: false })
	state.options.theme.roundness = {
		...state.options.theme.roundness,
		peek: () => {
			throw new Error("broken")
		},
	}
	state.module.default()
	await tick()
	assert.deepEqual(
		error.mock.calls.map((call) => call.arguments[0]),
		["startup.hyprland: Failed to synchronize appearance"],
	)
	assert.deepEqual(state.messages, [])
})

test("a wallpaper palette updates both schemes inside one CSS batch", async () => {
	const state = await fixture({ tmux: false, autotheme: true })
	state.module.default()
	const expected: string[] = []
	for (const [scheme, prefix] of [
		["dark", "d"],
		["light", "l"],
	])
		expected.push(
			`theme.${scheme}.bg=${prefix}bg`,
			`theme.${scheme}.fg=${prefix}fg`,
			`theme.${scheme}.widget=${prefix}widget`,
			`theme.${scheme}.border=${prefix}border`,
			`theme.${scheme}.primary.bg=${prefix}primary_bg`,
			`theme.${scheme}.primary.fg=${prefix}primary_fg`,
			`theme.${scheme}.error.bg=${prefix}error_bg`,
		)
	assert.deepEqual(state.sets, expected)
	assert.deepEqual(state.css, ["init", "begin", "end"])
})

test("palette sampling accepts setter-sized wallpapers and rejects sources outside its bounds", async (t) => {
	const logged: unknown[][] = []
	t.mock.method(console, "error", (...args: unknown[]) => {
		if (!String(args[0]).includes("ExperimentalWarning")) logged.push(args)
	})
	const option = (value) => ({
		peek: () => value,
		set() {},
		subscribe() {},
		id: String(value),
	})
	const colors = () => ({
		bg: option("#123456"),
		fg: option("#ffffff"),
		widget: option("#123456"),
		border: { ...option("#123456"), width: option(1) },
		primary: { bg: option("#123456"), fg: option("#ffffff") },
		error: { bg: option("#123456") },
	})
	const palette_colors = {
		bg: "#123456",
		fg: "#ffffff",
		widget: "#123456",
		border: "#123456",
		primary_bg: "#123456",
		primary_fg: "#ffffff",
		error_bg: "#123456",
	}
	let dimensions = [6000, 6000]
	let bytes = 64 * 1024 * 1024
	let revision = 0
	let changed
	let info_checks = 0
	let sampled = 0
	const messages: string[] = []
	const theme = {
		scheme: option("dark"),
		dark: colors(),
		light: colors(),
		spacing: option(6),
		roundness: option(12),
		border: { width: option(1) },
		blur: option(false),
		shadows: option(false),
	}
	const imports = {
		"ags/process": { execAsync: async () => "" },
		"gi://Gio": {
			default: {
				Settings: class {
					get_string(key) {
						return key === "icon-theme" ? "" : "prefer-dark"
					}
				},
			},
		},
		"gi://GdkPixbuf": {
			default: {
				Pixbuf: {
					get_file_info: () => {
						info_checks++
						return [{}, ...dimensions]
					},
					new_from_file_at_scale: () => ({
						get_pixels: () => new Uint8Array([64, 128, 192]),
						get_width: () => 1,
						get_height: () => 1,
						get_rowstride: () => 3,
						get_n_channels: () => 3,
						get_has_alpha: () => false,
					}),
				},
			},
		},
		"gi://GLib": { default: { find_program_in_path: () => null } },
		style: { init_css() {}, begin_css_batch() {}, end_css_batch() {} },
		"$lib/colors": {
			build_wallpaper_palette: (samples) => {
				assert.equal(samples.length, 1)
				sampled++
				return { dark: palette_colors, light: palette_colors }
			},
		},
		"$lib/env": { default: { init: () => ({ ok: true }) } },
		"$lib/time": { debounce: (_ms, fn) => ({ call: fn, cancel() {} }) },
		"$lib/textures": { get_file_size: () => bytes },
		"$lib/hyprland": with_hyprland_command({
			hyprland: {
				connect() {},
				message_async: async (message) => {
					messages.push(message)
					return "ok"
				},
			},
		}),
		"$lib/wallpaper": {
			wallpaper_path: "/wall",
			wallpaper_revision: {
				peek: () => revision,
				subscribe: (fn) => {
					changed = fn
				},
			},
		},
		"$shell/options": {
			default: {
				theme,
				autotheme: { peek: () => true, subscribe() {} },
				hyprland: { gaps: option(2), inactiveBorder: option("#000000") },
			},
			subscribe_options() {},
		},
	}
	const files = await load_module(
		"lib/files.ts",
		{ "gi://Gio": imports["gi://Gio"], "gi://GLib": imports["gi://GLib"] },
		createContext({ console }),
	)
	const module = await load_module(
		"shell/startup.ts",
		{ ...imports, "$lib/files": files },
		createContext({ console: { error() {} } }),
	)
	const started = module.default()
	assert.equal(started.ok, true, String(started.err))
	await tick()
	assert.deepEqual(messages, [
		'eval hl.config({ general = { border_size = 1, gaps_out = 12, gaps_in = 6, col = { active_border = "rgba(123456ff)", inactive_border = "rgba(000000ff)" } }, decoration = { rounding = 12, shadow = { enabled = false }, blur = { enabled = false } } })',
	])
	assert.equal(sampled, 1)
	assert.equal(info_checks, 1)
	assert.equal(logged.length, 0)
	dimensions = [6400, 6400]
	revision++
	changed()
	assert.equal(sampled, 1)
	assert.equal(info_checks, 2)
	assert.deepEqual(
		logged.map(([tag, error]) => [tag, (error as Error).message]),
		[
			[
				"wallpaper.theme: Failed to sample wallpaper",
				"Wallpaper dimensions exceed palette sampling limit",
			],
		],
	)
	bytes++
	revision++
	changed()
	assert.equal(info_checks, 2)
	assert.equal(sampled, 1)
})
