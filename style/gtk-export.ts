import { writeFileAsync } from "ags/file"
import GLib from "gi://GLib"

import options from "options"
import { ensurePath, fileExists } from "$lib/files"
import { calculateNeumorphicEffects, pickThemeValue } from "./theme-utils"

const GTK_THEME_NAME = "ags2-shell"
const LEGACY_GTK_OVERRIDE_MARKER = "/* ags2-shell: managed */"
const GTK4_OVERRIDE_MARKER = "/* ags2-shell: gtk4-override */"

type ExportPayload = {
	lightVars: string
	darkVars: string
	isDarkMode: boolean
}

export function writeGtkExports({ lightVars, darkVars, isDarkMode }: ExportPayload) {
	const lightExtras = buildGtkNeumorphicOverrides(false)
	const darkExtras = buildGtkNeumorphicOverrides(true)
	const lightCss = buildGtkExportCss(lightVars, lightExtras)
	const darkCss = buildGtkExportCss(darkVars, darkExtras)

	writeGtkTheme(lightCss, darkCss)
	writeGtk4Overrides(lightCss, darkCss, isDarkMode)
}

export function removeGtkExports() {
	removeGtkTheme()
	removeGtk4Overrides()
	removeLegacyGtkOverrides()
}

function buildGtkExportCss(cssVariables: string, extraCss: string): string {
	const lines = cssVariables.split("\n")
	const defineColors = lines.filter(line => line.startsWith("@define-color"))
	return `${defineColors.join("\n")}\n${extraCss}\n`
}

function buildGtkNeumorphicOverrides(isDarkMode: boolean): string {
	const tooltipCss = [
		"tooltip { background-color: @popover_bg_color; color: @popover_fg_color; box-shadow: inset 0 0 0 1px @popover_border_color; }",
		"tooltip label { color: @popover_fg_color; }",
		"",
	]

	if (!options.theme.neumorphic.peek()) return tooltipCss.join("\n")
	const fgColor = pickThemeValue(isDarkMode, options.theme.dark.fg, options.theme.light.fg)
	const effects = calculateNeumorphicEffects(true, isDarkMode, fgColor)
	const buttonBase = "button:not(.flat):not(.image-button):not(.titlebutton)"
	const buttonHover = `${buttonBase}:hover:not(:active):not(:checked)`
	const buttonActive = `${buttonBase}:active, ${buttonBase}:checked, ${buttonBase}.toggle:checked`
	const accentButtons = `${buttonBase}.suggested-action, ${buttonBase}.accent, ${buttonBase}.primary, button.suggested-action, button.accent, button.primary`
	const toggleBase = "switch, checkbutton, radiobutton"
	const toggleHover = `${toggleBase}:hover`
	const toggleActive = `${toggleBase}:checked, ${toggleBase}:active`
	const toggleAccent = "switch:checked"
	const toggleOff = "switch:not(:checked)"
	const linkedButtons = ".linked > button, .linked > .button, .linked > .toggle, .linked > .togglebutton, .linked > .image-button"
	const linkedStates = `${linkedButtons}, ${linkedButtons}:hover, ${linkedButtons}:active, ${linkedButtons}:checked`
	const stackSwitcher = "stack-switcher, .stack-switcher"
	const stackSwitcherHover = `${stackSwitcher}:hover`
	const stackSwitcherActive = `${stackSwitcher}:active`
	const searchBarBase = "searchbar, .searchbar, .search-bar"
	const searchBarSurface = `${searchBarBase} .linked, ${searchBarBase} .linked > box, ${searchBarBase} .linked > .box`
	const searchBarSurfaceHover = `${searchBarSurface}:hover, ${searchBarBase} .linked:hover`
	const searchBarSurfaceActive = `${searchBarSurface}:active, ${searchBarBase} .linked:active, ${searchBarBase} .linked:focus-within`
	const searchBarButtons = `${searchBarBase} button, ${searchBarBase} .button, ${searchBarBase} .toggle, ${searchBarBase} .togglebutton, ${searchBarBase} .image-button`
	const searchBarEntry = `${searchBarBase} entry`
	const nautilusPathBar = "NautilusPathBar, .nautilus-path-bar, .path-bar"
	const nautilusPathSurface = `${nautilusPathBar}, ${nautilusPathBar} .linked`
	const nautilusPathSurfaceHover = `${nautilusPathSurface}:hover`
	const nautilusPathSurfaceActive = `${nautilusPathSurface}:active, ${nautilusPathSurface}:focus-within`
	const nautilusPathButtons = `${nautilusPathBar} button, ${nautilusPathBar} .button, ${nautilusPathBar} .toggle, ${nautilusPathBar} .togglebutton, ${nautilusPathBar} .image-button, NautilusPathButton`

	return [
		`${buttonBase} { background-color: @card_bg_color; color: @card_fg_color; box-shadow: ${effects.buttonHighlight}, ${effects.buttonShadow}; }`,
		`${accentButtons} { background-color: @accent_bg_color; color: @accent_fg_color; }`,
		`${buttonHover} { box-shadow: ${effects.buttonHoverHighlight}, ${effects.buttonHoverShadow}; }`,
		`${buttonActive} { box-shadow: ${effects.buttonActiveHighlight}, ${effects.buttonActiveShadow}; }`,
		`${toggleBase} { background-color: @card_bg_color; color: @card_fg_color; box-shadow: ${effects.buttonHighlight}, ${effects.buttonShadow}; }`,
		`${toggleOff} { background-color: @card_bg_color; color: @card_fg_color; }`,
		`${toggleHover} { box-shadow: ${effects.buttonHoverHighlight}, ${effects.buttonHoverShadow}; }`,
		`${toggleActive} { box-shadow: ${effects.buttonActiveHighlight}, ${effects.buttonActiveShadow}; }`,
		`${toggleAccent} { background-color: @accent_bg_color; color: @accent_fg_color; }`,
		`${linkedStates} { box-shadow: none; }`,
		`${stackSwitcher} { box-shadow: ${effects.buttonHighlight}, ${effects.buttonShadow}; }`,
		`${stackSwitcherHover} { box-shadow: ${effects.buttonHoverHighlight}, ${effects.buttonHoverShadow}; }`,
		`${stackSwitcherActive} { box-shadow: ${effects.buttonActiveHighlight}, ${effects.buttonActiveShadow}; }`,
		`${searchBarSurface} { box-shadow: ${effects.buttonHighlight}, ${effects.buttonShadow}; }`,
		`${searchBarSurfaceHover} { box-shadow: ${effects.buttonHoverHighlight}, ${effects.buttonHoverShadow}; }`,
		`${searchBarSurfaceActive} { box-shadow: ${effects.buttonActiveHighlight}, ${effects.buttonActiveShadow}; }`,
		`${searchBarButtons} { box-shadow: none; background-color: transparent; }`,
		`${searchBarEntry} { box-shadow: none; }`,
		`${nautilusPathSurface} { box-shadow: ${effects.buttonHighlight}, ${effects.buttonShadow}; }`,
		`${nautilusPathSurfaceHover} { box-shadow: ${effects.buttonHoverHighlight}, ${effects.buttonHoverShadow}; }`,
		`${nautilusPathSurfaceActive} { box-shadow: ${effects.buttonActiveHighlight}, ${effects.buttonActiveShadow}; }`,
		`${nautilusPathButtons} { box-shadow: none; background-color: transparent; }`,
		`entry { box-shadow: ${effects.entryInset}; }`,
		...tooltipCss,
]
		.join("\n")
}

function buildGtk4ThemeCss(baseCss: string, isDark: boolean): string {
	const baseImport = isDark
		? '@import url("resource:///org/gnome/adwaita/gtk-dark.css");'
		: '@import url("resource:///org/gnome/adwaita/gtk.css");'
	return `${baseImport}\n${baseCss}\n`
}

function writeGtkTheme(lightCss: string, darkCss: string) {
	removeLegacyGtkOverrides()
	const dataDir = GLib.get_user_data_dir()
	const themeDir = GLib.build_filenamev([dataDir, "themes", GTK_THEME_NAME])
	const gtk4Dir = GLib.build_filenamev([themeDir, "gtk-4.0"])
	const gtk3Dir = GLib.build_filenamev([themeDir, "gtk-3.0"])

	ensurePath(`${gtk4Dir}/`)
	ensurePath(`${gtk3Dir}/`)

	const indexThemePath = GLib.build_filenamev([themeDir, "index.theme"])
	const indexTheme = [
		"[Desktop Entry]",
		"Type=Theme",
		`Name=${GTK_THEME_NAME}`,
		"Comment=ags2-shell GTK theme",
		"Inherits=Adwaita",
		"",
	].join("\n")

	writeFileAsync(indexThemePath, indexTheme)
	writeFileAsync(GLib.build_filenamev([gtk4Dir, "gtk.css"]), buildGtk4ThemeCss(lightCss, false))
	writeFileAsync(GLib.build_filenamev([gtk4Dir, "gtk-dark.css"]), buildGtk4ThemeCss(darkCss, true))
	const lightBase = pickThemeValue(false, options.theme.dark.bg, options.theme.light.bg)
	const darkBase = pickThemeValue(true, options.theme.dark.bg, options.theme.light.bg)
	writeFileAsync(GLib.build_filenamev([gtk3Dir, "gtk.css"]), toGtk3Css(lightCss, lightBase))
	writeFileAsync(GLib.build_filenamev([gtk3Dir, "gtk-dark.css"]), toGtk3Css(darkCss, darkBase))
}

function writeGtk4Overrides(lightCss: string, darkCss: string, isDarkMode: boolean) {
	const configDir = GLib.get_user_config_dir()
	const gtk4Dir = GLib.build_filenamev([configDir, "gtk-4.0"])
	ensurePath(`${gtk4Dir}/`)

	const gtk4Css = GLib.build_filenamev([gtk4Dir, "gtk.css"])
	const gtk4DarkCss = GLib.build_filenamev([gtk4Dir, "gtk-dark.css"])

	const lightOverride = `${GTK4_OVERRIDE_MARKER}\n${lightCss}\n`
	const darkOverride = `${GTK4_OVERRIDE_MARKER}\n${darkCss}\n`
	const activeOverride = isDarkMode ? darkOverride : lightOverride

	writeFileAsync(gtk4Css, activeOverride)
	writeFileAsync(gtk4DarkCss, activeOverride)
}

function removeGtk4Overrides() {
	const configDir = GLib.get_user_config_dir()
	const gtk4Dir = GLib.build_filenamev([configDir, "gtk-4.0"])
	const targets = [
		GLib.build_filenamev([gtk4Dir, "gtk.css"]),
		GLib.build_filenamev([gtk4Dir, "gtk-dark.css"]),
	]

	for (const filePath of targets) {
		if (!fileExists(filePath)) continue
		try {
			const [ok, bytes] = GLib.file_get_contents(filePath)
			if (!ok || !bytes) continue
			const contents = new TextDecoder().decode(bytes)
			if (!contents.startsWith(GTK4_OVERRIDE_MARKER)) continue
			GLib.unlink(filePath)
		} catch {
		}
	}
}

function removeLegacyGtkOverrides() {
	const configDir = GLib.get_user_config_dir()
	const gtk4Dir = GLib.build_filenamev([configDir, "gtk-4.0"])
	const gtk3Dir = GLib.build_filenamev([configDir, "gtk-3.0"])
	const targets = [
		GLib.build_filenamev([gtk4Dir, "gtk.css"]),
		GLib.build_filenamev([gtk4Dir, "gtk-dark.css"]),
		GLib.build_filenamev([gtk3Dir, "gtk.css"]),
		GLib.build_filenamev([gtk3Dir, "gtk-dark.css"]),
	]

	for (const filePath of targets) {
		if (!fileExists(filePath)) continue
		try {
			const [ok, bytes] = GLib.file_get_contents(filePath)
			if (!ok || !bytes) continue
			const contents = new TextDecoder().decode(bytes)
			if (!contents.startsWith(LEGACY_GTK_OVERRIDE_MARKER)) continue
			GLib.unlink(filePath)
		} catch {
		}
	}
}

function removeGtkTheme() {
	const dataDir = GLib.get_user_data_dir()
	const themeDir = GLib.build_filenamev([dataDir, "themes", GTK_THEME_NAME])
	const targets = [
		GLib.build_filenamev([themeDir, "index.theme"]),
		GLib.build_filenamev([themeDir, "gtk-4.0", "gtk.css"]),
		GLib.build_filenamev([themeDir, "gtk-4.0", "gtk-dark.css"]),
		GLib.build_filenamev([themeDir, "gtk-3.0", "gtk.css"]),
		GLib.build_filenamev([themeDir, "gtk-3.0", "gtk-dark.css"]),
	]

	for (const filePath of targets) {
		if (!fileExists(filePath)) continue
		try {
			GLib.unlink(filePath)
		} catch {
		}
	}
}

function toGtk3Css(css: string, baseBg: string): string {
	const mixed = css.replace(
		/color-mix\(in srgb,\s*([^\s]+)\s*(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)/g,
		(_, color: string, percent: string) => colorMixToRgba(color, Number(percent) / 100)
	)
	return flattenRgba(mixed, baseBg)
}

function flattenRgba(css: string, baseBg: string): string {
	const base = parseColor(baseBg)
	if (!base) return css
	return css.replace(
		/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/g,
		(_, r: string, g: string, b: string, a: string) => {
			const alpha = Math.min(1, Math.max(0, Number(a)))
			const outR = Math.round(Number(r) * alpha + base.r * (1 - alpha))
			const outG = Math.round(Number(g) * alpha + base.g * (1 - alpha))
			const outB = Math.round(Number(b) * alpha + base.b * (1 - alpha))
			return `rgb(${outR}, ${outG}, ${outB})`
		}
	)
}

function colorMixToRgba(color: string, mixAlpha: number): string {
	const parsed = parseColor(color)
	if (!parsed) return color
	const { r, g, b, a } = parsed
	const alpha = Math.min(1, Math.max(0, a * mixAlpha))
	const rounded = Number(alpha.toFixed(3))
	return `rgba(${r}, ${g}, ${b}, ${rounded})`
}

function parseColor(color: string): { r: number, g: number, b: number, a: number } | null {
	if (color.startsWith("#")) {
		const hex = color.slice(1)
		if (hex.length === 3) {
			const r = parseInt(hex[0] + hex[0], 16)
			const g = parseInt(hex[1] + hex[1], 16)
			const b = parseInt(hex[2] + hex[2], 16)
			return { r, g, b, a: 1 }
		}
		if (hex.length === 6 || hex.length === 8) {
			const r = parseInt(hex.slice(0, 2), 16)
			const g = parseInt(hex.slice(2, 4), 16)
			const b = parseInt(hex.slice(4, 6), 16)
			const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
			return { r, g, b, a }
		}
		return null
	}

	const rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/)
	if (rgbMatch) {
		return { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]), a: 1 }
	}

	const rgbaMatch = color.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/)
	if (rgbaMatch) {
		return { r: Number(rgbaMatch[1]), g: Number(rgbaMatch[2]), b: Number(rgbaMatch[3]), a: Number(rgbaMatch[4]) }
	}

	return null
}
