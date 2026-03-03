import { Gtk, Gdk } from "ags/gtk4"
import { monitorFile } from "ags/file"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import env from "$lib/env"
import { setHandler } from "$lib/option"
import { fileExists } from "$lib/files"
import options from "options"
import { writeGtkExports, removeGtkExports } from "./gtk-export"
import { calculateNeumorphicEffects, pickThemeValue, NeumorphicEffects } from "./theme-utils"

const { FontDescription, SCALE } = Pango

const RUNTIME_CSS_DEBOUNCE_MS = 20
const GTK_EXPORT_DEBOUNCE_MS = 220

let cssFilePath: string = ""
let resetCssSourceId: number | undefined = undefined
let gtkExportSourceId: number | undefined = undefined
let lastRuntimeCssContent: string = ""
let lastGtkExportKey: string = ""
let gtkExportsInstalled: boolean = false
let cssBatchDepth: number = 0
let cssBatchPending: boolean = false

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

function applyRuntimeCss(runtimeCssContent: string) {
	ensureProviders()
	runtimeProvider?.load_from_string(runtimeCssContent)
}

function syncGtkExports() {
	if (!options.theme.exportGtk.peek()) {
		if (!gtkExportsInstalled && !lastGtkExportKey)
			return

		gtkExportsInstalled = false
		lastGtkExportKey = ""
		removeGtkExports()
		return
	}

	const isDarkMode = options.theme.scheme.peek().includes("dark")

	const lightVars = buildGtkColorVariables(false)
	const darkVars = buildGtkColorVariables(true)
	const gtkExportKey = `${isDarkMode ? 1 : 0}:${lightVars}:${darkVars}`
	if (gtkExportsInstalled && gtkExportKey === lastGtkExportKey)
		return

	lastGtkExportKey = gtkExportKey
	gtkExportsInstalled = true
	writeGtkExports({
		lightVars,
		darkVars,
		isDarkMode,
	})
}

function scheduleGtkExportSync() {
	if (gtkExportSourceId !== undefined) {
		GLib.Source.remove(gtkExportSourceId)
	}

	gtkExportSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, GTK_EXPORT_DEBOUNCE_MS, () => {
		gtkExportSourceId = undefined
		syncGtkExports()
		return GLib.SOURCE_REMOVE
	})
}

function colorMix(color: string, opacityPercent: number): string {
	return `color-mix(in srgb, ${color} ${opacityPercent}%, transparent)`
}

function darkenHexColor(hexColor: string): string {
	const hexMatch = hexColor.match(/^#([0-9a-f]{6})$/i)
	if (!hexMatch) return hexColor

	const hex = hexMatch[1]
	const r = parseInt(hex.substring(0, 2), 16)
	const g = parseInt(hex.substring(2, 4), 16)
	const b = parseInt(hex.substring(4, 6), 16)

	const darken = (channel: number) => Math.round(channel * 0.96)
	const toHex = (channel: number) => channel.toString(16).padStart(2, "0")

	return `#${[r, g, b].map(darken).map(toHex).join("")}`
}

type Palette = {
	bg: string
	fg: string
	widgetBg: string
	hoverBg: string
	border: string
	popoverBorder: string
	primaryBg: string
	primaryFg: string
	errorBg: string
	errorFg: string
	activeGradient: string
	shadow: string
	shades: {
		headerbar: string
		headerbarDarker: string
		sidebar: string
		secondarySidebar: string
		scrollbarOutline: string
		shade: string
	}
}

type LayoutVars = {
	padding: number
	spacing: number
	radius: number
	transitionDuration: number
	borderWidth: number
	fontSize: number
	fontName: string
	screenCornerRadius: number
}

function computePalette(isDarkMode: boolean): Palette {
	const theme = options.theme

	const opacity = theme.opacity.peek()
	const effectiveOpacity = isDarkMode ? opacity : opacity / 2
	const baseBg = pickThemeValue(isDarkMode, theme.dark.bg, theme.light.bg)
	const bg = opacity > 0
		? colorMix(baseBg, Math.round((1 - effectiveOpacity / 100) * 100))
		: baseBg

	const shadow = theme.shadows.peek()
		? (isDarkMode ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.4)")
		: "transparent"

	const primaryBg = pickThemeValue(isDarkMode, theme.dark.primary.bg, theme.light.primary.bg)
	const primaryFg = pickThemeValue(isDarkMode, theme.dark.primary.fg, theme.light.primary.fg)

	const widgetBase = pickThemeValue(isDarkMode, theme.dark.widget, theme.light.widget)
	const widgetOpacity = theme.widget.opacity.peek()

	const borderBase = pickThemeValue(isDarkMode, theme.dark.border, theme.light.border)
	const borderOpacity = theme.border.opacity.peek()

	const fg = pickThemeValue(isDarkMode, theme.dark.fg, theme.light.fg)

	return {
		bg,
		fg,
		widgetBg: colorMix(widgetBase, 100 - widgetOpacity),
		hoverBg: colorMix(widgetBase, 100 - (widgetOpacity * 0.9)),
		border: colorMix(borderBase, 100 - borderOpacity),
		popoverBorder: colorMix(borderBase, 100 - Math.max(borderOpacity - 1, 0)),
		primaryBg,
		primaryFg,
		errorBg: pickThemeValue(isDarkMode, theme.dark.error.bg, theme.light.error.bg),
		errorFg: pickThemeValue(isDarkMode, theme.dark.error.fg, theme.light.error.fg),
		activeGradient: `linear-gradient(to right, ${primaryBg}, ${darkenHexColor(primaryBg)})`,
		shadow,
		shades: {
			headerbar: colorMix(fg, 12),
			headerbarDarker: colorMix(fg, 18),
			sidebar: colorMix(fg, 10),
			secondarySidebar: colorMix(fg, 8),
			scrollbarOutline: colorMix(fg, 30),
			shade: colorMix(fg, 15),
		},
	}
}

function buildCssVariables(isDarkMode: boolean): string {
	const theme = options.theme
	const palette = computePalette(isDarkMode)

	const radius = theme.roundness.peek()
	const gapsScale = options.hyprland.gaps.peek()
	const cornerScale = options.bar.corners.peek() * 0.01

	const fontDesc = FontDescription.from_string(String(options.font.peek()))

	const layout: LayoutVars = {
		padding: theme.padding.peek(),
		spacing: theme.spacing.peek(),
		radius,
		transitionDuration: options.transition.duration.peek(),
		borderWidth: theme.border.width.peek(),
		fontSize: Math.round(fontDesc.get_size() / SCALE) || 11,
		fontName: fontDesc.get_family() || "Sans",
		screenCornerRadius: radius * gapsScale * cornerScale,
	}

	const neu = calculateNeumorphicEffects(theme.neumorphic.peek(), isDarkMode, palette.fg)

	return [
		buildGtkColorDefinitions(palette),
		"",
		buildCustomProperties(palette, layout, neu),
	].join("\n")
}

function buildGtkColorVariables(isDarkMode: boolean): string {
	return buildGtkColorDefinitions(computePalette(isDarkMode))
}

function buildRuntimeCss(cssVariables: string): string {
	const lines = cssVariables.split("\n")
	const defineColors = lines.filter(line => line.startsWith("@define-color"))
	const cssVars = lines.filter(line => !line.startsWith("@define-color") && line.trim() !== "")
	return `${defineColors.join("\n")}\n\n* {\n${cssVars.join("\n")}\n}\n`
}

function buildGtkColorDefinitions(p: Palette): string {
	const shadowColorRgba = p.shadow !== "transparent" ? p.shadow : "rgba(0, 0, 0, 0.6)"

	return [
		`@define-color window_bg_color ${p.bg};`,
		`@define-color window_fg_color ${p.fg};`,
		`@define-color view_bg_color ${p.bg};`,
		`@define-color view_fg_color ${p.fg};`,
		`@define-color card_bg_color ${p.widgetBg};`,
		`@define-color card_fg_color ${p.fg};`,
		`@define-color dialog_bg_color ${p.bg};`,
		`@define-color dialog_fg_color ${p.fg};`,
		`@define-color popover_bg_color ${p.bg};`,
		`@define-color popover_fg_color ${p.fg};`,
		"",
		`@define-color headerbar_bg_color ${p.bg};`,
		`@define-color headerbar_fg_color ${p.fg};`,
		`@define-color headerbar_border_color ${p.border};`,
		`@define-color headerbar_backdrop_color ${p.bg};`,
		`@define-color headerbar_shade_color ${p.shades.headerbar};`,
		`@define-color headerbar_darker_shade_color ${p.shades.headerbarDarker};`,
		"",
		`@define-color sidebar_bg_color ${p.widgetBg};`,
		`@define-color sidebar_fg_color ${p.fg};`,
		`@define-color sidebar_backdrop_color ${p.widgetBg};`,
		`@define-color sidebar_shade_color ${p.shades.sidebar};`,
		`@define-color sidebar_border_color ${p.border};`,
		"",
		`@define-color secondary_sidebar_bg_color ${p.bg};`,
		`@define-color secondary_sidebar_fg_color ${p.fg};`,
		`@define-color secondary_sidebar_backdrop_color ${p.bg};`,
		`@define-color secondary_sidebar_shade_color ${p.shades.secondarySidebar};`,
		`@define-color secondary_sidebar_border_color ${p.border};`,
		"",
		`@define-color accent_bg_color ${p.primaryBg};`,
		`@define-color accent_fg_color ${p.primaryFg};`,
		`@define-color accent_color ${p.primaryBg};`,
		"",
		`@define-color scrollbar_outline_color ${p.shades.scrollbarOutline};`,
		`@define-color shade_color ${p.shades.shade};`,
		`@define-color shadow_color ${shadowColorRgba};`,
	].join("\n")
}

function buildCustomProperties(p: Palette, layout: LayoutVars, neu: NeumorphicEffects): string {
	return [
		`--bg: ${p.bg};`,
		`--fg: ${p.fg};`,
		`--primary-bg: ${p.primaryBg};`,
		`--primary-fg: ${p.primaryFg};`,
		`--error-bg: ${p.errorBg};`,
		`--error-fg: ${p.errorFg};`,
		`--padding: ${layout.padding}pt;`,
		`--spacing: ${layout.spacing}pt;`,
		`--radius: ${layout.radius}px;`,
		`--transition: ${layout.transitionDuration}ms;`,
		`--border-width: ${layout.borderWidth}px;`,
		`--font-size: ${layout.fontSize}pt;`,
		`--font-name: "${layout.fontName}";`,
		`--screen-corner-radius: ${layout.screenCornerRadius}px;`,
		`--popover-padding: ${layout.padding * 1.6}pt;`,
		`--popover-radius: ${layout.radius * 2}px;`,
		`--shadow-color: ${p.shadow};`,
		`--active-gradient: ${p.activeGradient};`,
		`--widget-bg: ${p.widgetBg};`,
		`--hover-bg: ${p.hoverBg};`,
		`--border-color: ${p.border};`,
		`--popover-border-color: ${p.popoverBorder};`,
		`--neu-button-highlight: ${neu.buttonHighlight};`,
		`--neu-button-shadow: ${neu.buttonShadow};`,
		`--neu-button-hover-highlight: ${neu.buttonHoverHighlight};`,
		`--neu-button-hover-shadow: ${neu.buttonHoverShadow};`,
		`--neu-button-active-highlight: ${neu.buttonActiveHighlight};`,
		`--neu-button-active-shadow: ${neu.buttonActiveShadow};`,
		`--neu-widget-highlight: ${neu.widgetHighlight};`,
		`--neu-widget-shadow: ${neu.widgetShadow};`,
		`--neu-trough-inset: ${neu.troughInset};`,
		`--neu-progress-highlight: ${neu.progressHighlight};`,
		`--neu-progress-shadow: ${neu.progressShadow};`,
		`--neu-slider-highlight: ${neu.sliderHighlight};`,
		`--neu-entry-inset: ${neu.entryInset};`,
	].join("\n")
}

function performResetCss() {
	if (!fileExists(cssFilePath)) {
		logError(new Error(`CSS file not found: ${cssFilePath}`))
		return
	}

	const isDarkMode = options.theme.scheme.peek().includes("dark")
	const cssVariables = buildCssVariables(isDarkMode)
	const runtimeCssContent = buildRuntimeCss(cssVariables)
	if (runtimeCssContent === lastRuntimeCssContent)
		return

	lastRuntimeCssContent = runtimeCssContent
	applyRuntimeCss(runtimeCssContent)
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

function onRecompile() {
	monitorFile(cssFilePath, () => {
		loadStaticCss()
		resetCss()
	})
}

export function initCss() {
	const configDir = GLib.getenv("AGS2SHELL_STYLES") ?? env.paths.cfg
	cssFilePath = GLib.build_filenamev([configDir, "style", "compile", "main.css"])

	const runtimeOptionDependencies = [
		"font",
		"theme",
		"theme.scheme",
		"theme.neumorphic",
		"theme.exportGtk",
		"bar.corners",
		"bar.position",
		"hyprland.gaps",
		"transition.duration"
	]

	const gtkExportDependencies = [
		"theme.dark",
		"theme.light",
		"theme.opacity",
		"theme.widget.opacity",
		"theme.border.opacity",
		"theme.shadows",
		"theme.neumorphic",
		"theme.scheme",
		"theme.exportGtk",
	]

	ensureProviders()

	setHandler(options, runtimeOptionDependencies, resetCss)
	setHandler(options, gtkExportDependencies, scheduleGtkExportSync)
	resetCss()
	scheduleGtkExportSync()

	onRecompile()
}
