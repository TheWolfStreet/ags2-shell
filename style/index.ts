// Loads CSS and updates it when appearance settings change.
import { Gtk, Gdk } from "ags/gtk4"
import { monitorFile } from "ags/file"
import GLib from "gi://GLib"

import env from "$lib/env"
import { fileExists } from "$lib/files"
import options, { subscribeOptions } from "$shell/options"
import { buildRuntimeCss } from "./runtime-css"

const RUNTIME_CSS_DEBOUNCE_MS = 20

let cssFilePath = ""
let resetCssSourceId: number | undefined
let lastRuntimeCssContent = ""
let cssBatchDepth = 0
let cssBatchPending = false

let staticProvider: Gtk.CssProvider | undefined
let runtimeProvider: Gtk.CssProvider | undefined

function ensureProviders() {
	if (staticProvider)
		return

	const display = Gdk.Display.get_default()
	if (!display)
		return

	staticProvider = new Gtk.CssProvider()
	Gtk.StyleContext.add_provider_for_display(display, staticProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
	loadStaticCss()
}

function loadStaticCss() {
	if (staticProvider && fileExists(cssFilePath))
		staticProvider.load_from_path(cssFilePath)
}

function performResetCss() {
	if (!fileExists(cssFilePath)) {
		logError(new Error(`CSS file not found: ${cssFilePath}`))
		return
	}

	const runtimeCssContent = buildRuntimeCss()
	if (runtimeCssContent === lastRuntimeCssContent)
		return

	ensureProviders()
	const display = Gdk.Display.get_default()
	if (!display)
		return

	const nextProvider = new Gtk.CssProvider()
	nextProvider.load_from_string(runtimeCssContent)
	if (runtimeProvider)
		Gtk.StyleContext.remove_provider_for_display(display, runtimeProvider)
	runtimeProvider = nextProvider
	Gtk.StyleContext.add_provider_for_display(display, runtimeProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1)
	lastRuntimeCssContent = runtimeCssContent
}

function resetCss() {
	if (cssBatchDepth > 0) {
		cssBatchPending = true
		return
	}

	if (resetCssSourceId !== undefined)
		return

	resetCssSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RUNTIME_CSS_DEBOUNCE_MS, () => {
		resetCssSourceId = undefined
		performResetCss()
		return GLib.SOURCE_REMOVE
	})
}

export function beginCssBatch() {
	cssBatchDepth += 1
}

export function endCssBatch() {
	if (cssBatchDepth <= 0)
		return

	cssBatchDepth -= 1
	if (cssBatchDepth === 0 && cssBatchPending) {
		cssBatchPending = false
		resetCss()
	}
}

function watchStaticCss() {
	monitorFile(cssFilePath, () => {
		loadStaticCss()
		resetCss()
	})
}

export function initCss() {
	const bundledStyleDir = typeof STYLE_DIR !== "undefined" ? STYLE_DIR : null
	const configDir = GLib.getenv("AGS2SHELL_STYLES") ?? bundledStyleDir ?? env.paths.cfg
	cssFilePath = GLib.build_filenamev([configDir, "style", "compile", "main.css"])

	ensureProviders()
	subscribeOptions(options, [
		"scale",
		"font",
		"theme",
		"bar.corners",
		"hyprland.gaps",
		"transition.duration",
	], resetCss)
	performResetCss()
	watchStaticCss()
}
