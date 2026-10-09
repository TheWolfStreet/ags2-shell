import { Gtk, Gdk } from "ags/gtk4"
import { monitorFile } from "ags/file"
import GLib from "gi://GLib"

import env from "$lib/env"
import { file_exists } from "$lib/files"
import options, { subscribe_options } from "$shell/options"
import { build_runtime_css } from "./runtime-css"

const RUNTIME_CSS_DEBOUNCE_MS = 20

let css_file_path = ""
let reset_css_source_id: number | undefined
let last_runtime_css_content = ""
let css_batch_depth = 0
let css_batch_pending = false

let static_provider: Gtk.CssProvider | undefined
let runtime_provider: Gtk.CssProvider | undefined

function ensure_providers() {
	if (static_provider) return

	const display = Gdk.Display.get_default()
	if (!display) return

	static_provider = new Gtk.CssProvider()
	Gtk.StyleContext.add_provider_for_display(
		display,
		static_provider,
		Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
	)
	load_static_css()
}

function load_static_css() {
	if (static_provider && file_exists(css_file_path))
		static_provider.load_from_path(css_file_path)
}

function perform_reset_css() {
	if (!file_exists(css_file_path)) {
		logError(new Error(`CSS file not found: ${css_file_path}`))
		return
	}

	const runtime_css_content = build_runtime_css()
	if (runtime_css_content === last_runtime_css_content) return

	ensure_providers()
	const display = Gdk.Display.get_default()
	if (!display) return

	const next_provider = new Gtk.CssProvider()
	next_provider.load_from_string(runtime_css_content)
	if (runtime_provider)
		Gtk.StyleContext.remove_provider_for_display(display, runtime_provider)
	runtime_provider = next_provider
	Gtk.StyleContext.add_provider_for_display(
		display,
		runtime_provider,
		Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
	)
	last_runtime_css_content = runtime_css_content
}

function reset_css() {
	if (css_batch_depth > 0) {
		css_batch_pending = true
		return
	}

	if (reset_css_source_id !== undefined) return

	reset_css_source_id = GLib.timeout_add(
		GLib.PRIORITY_DEFAULT,
		RUNTIME_CSS_DEBOUNCE_MS,
		() => {
			reset_css_source_id = undefined
			perform_reset_css()
			return GLib.SOURCE_REMOVE
		},
	)
}

export function begin_css_batch() {
	css_batch_depth += 1
}

export function end_css_batch() {
	if (css_batch_depth <= 0) return

	css_batch_depth -= 1
	if (css_batch_depth === 0 && css_batch_pending) {
		css_batch_pending = false
		reset_css()
	}
}

function watch_static_css() {
	monitorFile(GLib.path_get_dirname(css_file_path), (file) => {
		if (file !== css_file_path) return
		load_static_css()
		reset_css()
	})
}

export function init_css() {
	const bundled_style_dir = typeof STYLE_DIR !== "undefined" ? STYLE_DIR : null
	const config_dir =
		GLib.getenv("AGS2SHELL_STYLES") ?? bundled_style_dir ?? env.paths.cfg
	css_file_path = GLib.build_filenamev([
		config_dir,
		"style",
		"compile",
		"main.css",
	])

	ensure_providers()
	subscribe_options(
		options,
		[
			"scale",
			"font",
			"theme",
			"bar.corners",
			"hyprland.gaps",
			"transition.duration",
		],
		reset_css,
	)
	perform_reset_css()
	watch_static_css()
}
