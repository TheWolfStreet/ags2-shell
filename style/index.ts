// Loads CSS and updates it when appearance settings change.
import { Gtk, Gdk } from "ags/gtk4"
import { monitorFile } from "ags/file"
import GLib from "gi://GLib"

import env from "$lib/env"
import { fileExists } from "$lib/files"
import { subscribeOptions } from "$lib/option"
import options from "options"
import { buildRuntimeCss } from "./theme"

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
	runtimeProvider = new Gtk.CssProvider()
	Gtk.StyleContext.add_provider_for_display(display, staticProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
	Gtk.StyleContext.add_provider_for_display(display, runtimeProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1)
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

	lastRuntimeCssContent = runtimeCssContent
	ensureProviders()
	runtimeProvider?.load_from_string(runtimeCssContent)
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
	const configDir = GLib.getenv("AGS2SHELL_STYLES") ?? env.paths.cfg
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
