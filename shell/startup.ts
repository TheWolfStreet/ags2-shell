import { execAsync } from "ags/process"

import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"

import { begin_css_batch, end_css_batch, init_css } from "style"
import {
	build_wallpaper_palette,
	type rgb,
	type wallpaper_palette,
} from "$lib/colors"
import env from "$lib/env"
import {
	attempt,
	attempt_async,
	err,
	log_error,
	ok,
	type result,
} from "$lib/result"
import { debounce } from "$lib/time"
import { get_file_size } from "$lib/textures"
import { max_image_bytes, valid_image_dimensions } from "$lib/files"
import { hyprland, hyprland_command } from "$lib/hyprland"
import { lua_string } from "$lib/lua"
import { wallpaper_path, wallpaper_revision } from "$lib/wallpaper"

import options, { subscribe_options } from "$shell/options"

const { scheme, dark, light } = options.theme
const scheme_sync_debounce_ms = 200

const settings = new Gio.Settings({
	schema: "org.gnome.desktop.interface",
})

const dark_icon_suffixes = ["-dark", "-Dark", "_dark"]
const light_icon_suffixes = ["-light", "-Light", "_light", ""]

function primary_color() {
	if (scheme.peek() === "dark") return dark.primary.bg.peek()
	return light.primary.bg.peek()
}

function serialized(task: () => Promise<void>, tag: string) {
	let queue = Promise.resolve()
	return () => {
		queue = queue.then(async () => {
			log_error(await attempt_async(task), tag)
		})
		return queue
	}
}

function sync_color_scheme() {
	const desired = `prefer-${scheme.peek()}`
	if (settings.get_string("color-scheme") !== desired)
		settings.set_string("color-scheme", desired)
}

function get_base_icon_theme(theme_name: string): string {
	return theme_name.replace(/[-_]?(dark|light)$/i, "")
}

function icon_theme_exists(theme_name: string): boolean {
	const icon_dirs = [
		GLib.build_filenamev([GLib.get_home_dir(), ".icons"]),
		GLib.build_filenamev([GLib.get_user_data_dir(), "icons"]),
		...GLib.get_system_data_dirs().map((dir) =>
			GLib.build_filenamev([dir, "icons"]),
		),
	]
	return icon_dirs.some((dir) =>
		GLib.file_test(
			GLib.build_filenamev([dir, theme_name, "index.theme"]),
			GLib.FileTest.EXISTS,
		),
	)
}

function sync_icon_theme() {
	const current_theme = settings.get_string("icon-theme")
	if (!current_theme) return

	const base_theme = get_base_icon_theme(current_theme)
	const suffixes =
		scheme.peek() === "dark" ? dark_icon_suffixes : light_icon_suffixes
	const candidate = suffixes
		.map((suffix) => base_theme + suffix)
		.find((theme) => icon_theme_exists(theme))
	if (candidate !== undefined && candidate !== current_theme)
		settings.set_string("icon-theme", candidate)
}

function tmux(args: string[]): Promise<result<string>> {
	return attempt_async(() => execAsync(["tmux", ...args]))
}

async function sync_tmux_accent() {
	const hex = primary_color()
	const global = await tmux(["set", "-g", "@main_accent", hex])
	if (!global.ok) console.debug("startup.tmux: Accent sync skipped", global.err)

	const sessions = await tmux(["list-sessions", "-F", "#S"])
	if (!sessions.ok) {
		console.debug("startup.tmux: No tmux sessions to sync", sessions.err)
		return
	}
	for (const session of sessions.value.split("\n").filter(Boolean)) {
		const updated = await tmux([
			"set-option",
			"-t",
			session,
			"@main_accent",
			hex,
		])
		if (!updated.ok)
			console.debug(
				`startup.tmux: Accent sync skipped for session ${session}`,
				updated.err,
			)
	}
}

const sync_scheme = debounce(scheme_sync_debounce_ms, () => {
	sync_color_scheme()
	sync_icon_theme()
})

const sync_tmux = debounce(
	60,
	serialized(sync_tmux_accent, "startup.tmux: Failed to synchronize accent"),
)

function start_tmux_accent_sync() {
	if (GLib.find_program_in_path("tmux") === null) return
	const sync_if_enabled = () => {
		if (options.tmux.accent.peek()) sync_tmux.call()
	}
	sync_if_enabled()
	options.tmux.accent.subscribe(sync_if_enabled)
	dark.primary.bg.subscribe(sync_if_enabled)
	light.primary.bg.subscribe(sync_if_enabled)
	scheme.subscribe(sync_if_enabled)
}

function hyprland_color(color: string) {
	return lua_string(`rgba(${color}ff)`.replace("#", ""))
}

async function apply_hyprland_appearance() {
	const { gaps, inactiveBorder } = options.hyprland
	const { spacing, roundness, border, blur, shadows } = options.theme
	const gaps_out = Math.floor(gaps.peek() * spacing.peek())
	const colors = `col = { active_border = ${hyprland_color(primary_color())}, inactive_border = ${hyprland_color(inactiveBorder.peek())} }`
	const general = `general = { border_size = ${border.width.peek()}, gaps_out = ${gaps_out}, gaps_in = ${Math.floor(gaps_out / 2)}, ${colors} }`
	const decoration = `decoration = { rounding = ${roundness.peek()}, shadow = { enabled = ${shadows.peek()} }, blur = { enabled = ${blur.peek()} } }`
	log_error(
		await hyprland_command(`eval hl.config({ ${general}, ${decoration} })`),
		"startup.hyprland: Failed to apply appearance",
	)
}

function start_hyprland_appearance_sync() {
	const { spacing, roundness, border, blur, shadows } = options.theme
	const dependencies = [
		"hyprland",
		spacing.id,
		roundness.id,
		border.width.id,
		blur.id,
		shadows.id,
		dark.primary.bg.id,
		light.primary.bg.id,
		scheme.id,
	]
	const update = debounce(
		100,
		serialized(
			apply_hyprland_appearance,
			"startup.hyprland: Failed to synchronize appearance",
		),
	)
	hyprland.connect("config-reloaded", () => update.call())
	subscribe_options(options, dependencies, () => update.call())
	update.call()
}

const sample_size = 96
const wallpaper_theme_delay_ms = 180
let last_wallpaper_revision = -1

function sample_wallpaper_pixels(path: string): result<rgb[]> {
	const info = attempt(() => GdkPixbuf.Pixbuf.get_file_info(path))
	if (!info.ok) return info

	const [, source_width, source_height] = info.value
	if (!valid_image_dimensions(source_width, source_height))
		return err(new Error("Wallpaper dimensions exceed palette sampling limit"))

	const pixbuf = attempt(() =>
		GdkPixbuf.Pixbuf.new_from_file_at_scale(
			path,
			sample_size,
			sample_size,
			true,
		),
	)
	if (!pixbuf.ok) return pixbuf
	return ok(collect_samples(pixbuf.value))
}

function collect_samples(pixbuf: GdkPixbuf.Pixbuf): rgb[] {
	const pixels = pixbuf.get_pixels()
	const width = pixbuf.get_width()
	const height = pixbuf.get_height()
	const rowstride = pixbuf.get_rowstride()
	const channels = pixbuf.get_n_channels()
	const has_alpha = pixbuf.get_has_alpha()
	const samples: rgb[] = []

	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const offset = y * rowstride + x * channels
			if (has_alpha && pixels[offset + 3] < 32) continue
			samples.push({
				r: pixels[offset] / 255,
				g: pixels[offset + 1] / 255,
				b: pixels[offset + 2] / 255,
			})
		}

	return samples
}

function apply_wallpaper_palette(palette: wallpaper_palette) {
	begin_css_batch()
	try {
		for (const name of ["dark", "light"] as const) {
			const target = options.theme[name]
			const colors = palette[name]
			target.bg.set(colors.bg)
			target.fg.set(colors.fg)
			target.widget.set(colors.widget)
			target.border.set(colors.border)
			target.primary.bg.set(colors.primary_bg)
			target.primary.fg.set(colors.primary_fg)
			target.error.bg.set(colors.error_bg)
		}
	} finally {
		end_css_batch()
	}
}

const update_wallpaper_theme = debounce(wallpaper_theme_delay_ms, () => {
	if (!options.autotheme.peek()) return
	const path = wallpaper_path
	const size = get_file_size(path)
	if (!size) return
	if (size > max_image_bytes) {
		console.error("wallpaper.theme: Wallpaper exceeds palette sampling limit")
		return
	}
	const revision = wallpaper_revision.peek()
	if (revision === last_wallpaper_revision) return

	const samples = sample_wallpaper_pixels(path)
	if (!log_error(samples, "wallpaper.theme: Failed to sample wallpaper")) return

	const palette = build_wallpaper_palette(samples.value)
	if (!palette) {
		console.error("wallpaper.theme: Wallpaper contained no usable pixels")
		return
	}

	apply_wallpaper_palette(palette)
	last_wallpaper_revision = revision
})

function start_wallpaper_theme() {
	wallpaper_revision.subscribe(() => update_wallpaper_theme.call())
	options.autotheme.subscribe(() => {
		if (options.autotheme.peek()) {
			last_wallpaper_revision = -1
			update_wallpaper_theme.call()
		} else {
			update_wallpaper_theme.cancel()
		}
	})
	update_wallpaper_theme.call()
}

export default function start_shell(): result<void> {
	const initialized = env.init()
	if (!initialized.ok) return initialized
	return attempt(() => {
		init_css()
		sync_color_scheme()
		sync_icon_theme()
		scheme.subscribe(() => sync_scheme.call())

		start_tmux_accent_sync()
		start_wallpaper_theme()
		start_hyprland_appearance_sync()
	})
}
