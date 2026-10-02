import { execAsync } from "ags/process"

import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"

import { begin_css_batch, end_css_batch, init_css } from "style"
import {
	build_wallpaper_palette,
	type Rgb,
	type WallpaperPalette,
} from "$lib/colors"
import env from "$lib/env"
import { attempt, attempt_async, log_error, type Result } from "$lib/result"
import { debounce } from "$lib/time"
import { get_file_size } from "$lib/textures"
import { hyprland } from "$lib/hyprland"
import { wallpaper_path, wallpaper_revision } from "$lib/wallpaper"

import options, { subscribe_options } from "$shell/options"

const { scheme, dark, light } = options.theme
const SCHEME_SYNC_DEBOUNCE_MS = 200

const settings = new Gio.Settings({
	schema: "org.gnome.desktop.interface",
})

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
	const is_dark = scheme.peek() === "dark"
	const suffixes = is_dark
		? ["-dark", "-Dark", "_dark"]
		: ["-light", "-Light", "_light", ""]

	for (const suffix of suffixes) {
		const candidate = base_theme + suffix
		if (icon_theme_exists(candidate)) {
			if (current_theme !== candidate)
				settings.set_string("icon-theme", candidate)
			return
		}
	}

	if (!is_dark && icon_theme_exists(base_theme) && current_theme !== base_theme)
		settings.set_string("icon-theme", base_theme)
}

async function sync_tmux_accent() {
	const hex =
		scheme.peek() === "dark" ? dark.primary.bg.peek() : light.primary.bg.peek()

	await execAsync(["tmux", "set", "-g", "@main_accent", hex]).catch((error) => {
		console.debug("startup.tmux: tmux accent sync skipped", error)
	})

	const raw_sessions = await execAsync([
		"tmux",
		"list-sessions",
		"-F",
		"#S",
	]).catch((error) => {
		console.debug("startup.tmux: no tmux sessions to sync", error)
		return ""
	})
	if (!raw_sessions) return

	const sessions = raw_sessions.split("\n").filter(Boolean)
	for (const session of sessions) {
		await execAsync(["tmux", "set-option", "-t", session, "@main_accent", hex]).catch(
			(error) => console.debug(`startup.tmux: accent sync skipped for session ${session}`, error),
		)
	}
}

const sync_scheme = debounce(SCHEME_SYNC_DEBOUNCE_MS, () => {
	sync_color_scheme()
	sync_icon_theme()
})

let tmux_sync = Promise.resolve()
const sync_tmux = debounce(60, () => {
	tmux_sync = tmux_sync.then(sync_tmux_accent).catch(error =>
		console.error("startup.tmux: Failed to synchronize accent", error))
	return tmux_sync
})

function start_hyprland_appearance_sync() {
	const {
		hyprland: hyprland_options,
		theme: {
			spacing,
			roundness,
			border: { width },
			blur,
			shadows,
		},
	} = options
	const dark_active = dark.primary.bg
	const light_active = light.primary.bg
	const dependencies = [
		"hyprland",
		spacing.id,
		roundness.id,
		width.id,
		blur.id,
		shadows.id,
		dark_active.id,
		light_active.id,
		scheme.id,
	]

	const primary = () =>
		scheme.peek() === "dark" ? dark_active.peek() : light_active.peek()
	const rgba = (color: string) => `rgba(${color}ff)`.replace("#", "")

	const apply_hyprland_appearance = async () => {
		const gaps = Math.floor(hyprland_options.gaps.peek() * spacing.peek())
		const rules = [
			`general:border_size ${width.peek()}`,
			`general:gaps_out ${gaps}`,
			`general:gaps_in ${Math.floor(gaps / 2)}`,
			`general:col.active_border ${rgba(primary())}`,
			`general:col.inactive_border ${rgba(hyprland_options.inactiveBorder.peek())}`,
			`decoration:rounding ${roundness.peek()}`,
			`decoration:shadow:enabled ${shadows.peek() ? "yes" : "no"}`,
			`decoration:blur:enabled ${blur.peek() ? "true" : "false"}`,
		]
		const batch = rules.map((rule) => `keyword ${rule}`).join("; ")
		const result = await attempt_async(() => hyprland.message_async(`[[BATCH]]/${batch}`))
		if (!result.ok || result.value !== "ok")
			console.error("startup.hyprland: Failed to apply appearance", result.ok ? result.value : result.err)
	}

	let pending = Promise.resolve()
	const update = debounce(100, () => {
		pending = pending.then(apply_hyprland_appearance).catch(error =>
			console.error("startup.hyprland: Failed to synchronize appearance", error))
		return pending
	})
	hyprland.connect("config-reloaded", () => update.call())
	subscribe_options(options, dependencies, () => update.call())
	update.call()
}

const SAMPLE_SIZE = 96
const MAX_WALLPAPER_BYTES = 64 * 1024 * 1024
const MAX_WALLPAPER_DIMENSION = 8192
const MAX_WALLPAPER_PIXELS = 40_000_000
const WALLPAPER_THEME_DELAY_MS = 180
let last_wallpaper_revision = -1

function sample_wallpaper_pixels(path: string): Rgb[] {
	const [, source_width, source_height] = GdkPixbuf.Pixbuf.get_file_info(path)
	if (source_width < 1 || source_height < 1 ||
		source_width > MAX_WALLPAPER_DIMENSION || source_height > MAX_WALLPAPER_DIMENSION ||
		source_width * source_height > MAX_WALLPAPER_PIXELS)
		throw new Error("Wallpaper dimensions exceed palette sampling limit")
	const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
		path,
		SAMPLE_SIZE,
		SAMPLE_SIZE,
		true,
	)
	const pixels = pixbuf.get_pixels()
	const width = pixbuf.get_width()
	const height = pixbuf.get_height()
	const rowstride = pixbuf.get_rowstride()
	const channels = pixbuf.get_n_channels()
	const has_alpha = pixbuf.get_has_alpha()
	const samples: Rgb[] = []

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = y * rowstride + x * channels
			if (has_alpha && pixels[offset + 3] < 32) continue
			samples.push({
				r: pixels[offset] / 255,
				g: pixels[offset + 1] / 255,
				b: pixels[offset + 2] / 255,
			})
		}
	}

	return samples
}

function apply_wallpaper_palette(colors: WallpaperPalette) {
	const { dark, light } = options.theme
	begin_css_batch()
	try {
		dark.bg.set(colors.dark.bg)
		dark.fg.set(colors.dark.fg)
		dark.widget.set(colors.dark.widget)
		dark.border.set(colors.dark.border)
		dark.primary.bg.set(colors.dark.primary_bg)
		dark.primary.fg.set(colors.dark.primary_fg)
		dark.error.bg.set(colors.dark.error_bg)
		light.bg.set(colors.light.bg)
		light.fg.set(colors.light.fg)
		light.widget.set(colors.light.widget)
		light.border.set(colors.light.border)
		light.primary.bg.set(colors.light.primary_bg)
		light.primary.fg.set(colors.light.primary_fg)
		light.error.bg.set(colors.light.error_bg)
	} finally {
		end_css_batch()
	}
}

const update_wallpaper_theme = debounce(WALLPAPER_THEME_DELAY_MS, () => {
	if (!options.autotheme.peek()) return
	const path = wallpaper_path
	const size = get_file_size(path)
	if (!size) return
	if (size > MAX_WALLPAPER_BYTES) {
		console.error("wallpaper.theme: Wallpaper exceeds palette sampling limit")
		return
	}
	const revision = wallpaper_revision.peek()
	if (revision === last_wallpaper_revision) return

	const result = attempt(() =>
		build_wallpaper_palette(sample_wallpaper_pixels(path)),
	)
	if (!log_error(result, "wallpaper.theme: Failed to sample wallpaper")) return
	if (!result.value) {
		console.error("wallpaper.theme: Wallpaper contained no usable pixels")
		return
	}

	apply_wallpaper_palette(result.value)
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

export default function start_shell(): Result<void> {
	const initialized = env.init()
	if (!initialized.ok) return initialized
	return attempt(() => {
		init_css()
		sync_color_scheme()
		sync_icon_theme()
		scheme.subscribe(() => sync_scheme.call())

		if (GLib.find_program_in_path("tmux") !== null) {
			tmux_sync = sync_tmux_accent().catch(error =>
				console.error("startup.tmux: Failed to synchronize accent", error))
			options.theme.dark.primary.bg.subscribe(() => sync_tmux.call())
			options.theme.light.primary.bg.subscribe(() => sync_tmux.call())
			options.theme.scheme.subscribe(() => sync_tmux.call())
		}

		start_wallpaper_theme()
		start_hyprland_appearance_sync()
	})
}
