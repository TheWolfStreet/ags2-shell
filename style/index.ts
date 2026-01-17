import app from "ags/gtk4/app"
import { writeFileAsync, monitorFile } from "ags/file"
import { timeout, idle, Timer } from "ags/time"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import env from "$lib/env"
import { Opt, setHandler } from "$lib/option"
import { fileExists } from "$lib/utils"
import options from "options"

let cssFilePath = ''
let cssReloadTimeout: Timer | undefined

function unwrapOption<T>(option: Opt<T> | T): T {
	return option instanceof Opt ? option.peek() : option
}

function pickThemeValue<T>(darkValue: Opt<T> | T, lightValue: Opt<T> | T): T {
	const isDarkMode = options.theme.scheme.peek().includes("dark")
	return unwrapOption(isDarkMode ? darkValue : lightValue)
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
	const toHex = (channel: number) => channel.toString(16).padStart(2, '0')

	return `#${[r, g, b].map(darken).map(toHex).join('')}`
}

function buildCssVariables(): string {
	const theme = options.theme
	const isDarkMode = theme.scheme.peek().includes("dark")

	const opacityLevel = theme.opacity.peek()
	const backgroundColor = opacityLevel > 0
		? colorMix(pickThemeValue(theme.dark.bg, theme.light.bg), Math.round((1 - opacityLevel / 100) * 100))
		: pickThemeValue(theme.dark.bg, theme.light.bg)

	const radiusValue = theme.radius.peek()
	const paddingValue = theme.padding.peek()
	const gapsMultiplier = options.hyprland.gaps.peek()
	const cornerMultiplier = options.bar.corners.peek() * 0.01
	const screenCornerRadius = radiusValue * gapsMultiplier * cornerMultiplier

	const shadowColor = theme.shadows.peek()
		? (isDarkMode ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.4)")
		: "transparent"

	const primaryBackground = pickThemeValue(theme.dark.primary.bg, theme.light.primary.bg)
	const activeGradient = `linear-gradient(to right, ${primaryBackground}, ${darkenHexColor(primaryBackground)})`

	const widgetBaseColor = pickThemeValue(theme.dark.widget, theme.light.widget)
	const widgetOpacity = theme.widget.opacity.peek()
	const widgetBackground = colorMix(widgetBaseColor, 100 - widgetOpacity)
	const hoverBackground = colorMix(widgetBaseColor, 100 - (widgetOpacity * 0.9))

	const borderBaseColor = pickThemeValue(theme.dark.border, theme.light.border)
	const borderOpacity = theme.border.opacity.peek()
	const borderColor = colorMix(borderBaseColor, 100 - borderOpacity)
	const popoverBorderColor = colorMix(borderBaseColor, 100 - Math.max(borderOpacity - 1, 0))

	const fontDesc = Pango.FontDescription.from_string(String(options.font.peek()))
	const fontName = fontDesc.get_family() || "Sans"
	const fontSize = Math.round(fontDesc.get_size() / Pango.SCALE) || 11

	const neumorphic = theme.neumorphic.peek()

	const fgColor = pickThemeValue(theme.dark.fg, theme.light.fg)
	const highlightColor = isDarkMode ? "white" : fgColor
	const shadowBaseColor = isDarkMode ? "black" : fgColor

	const neuButtonHighlight = neumorphic ? `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 15 : 10}%, transparent)` : "0 0 0 0 transparent"
	const neuButtonShadow = neumorphic ? `0 1px 2px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 20 : 14}%, transparent)` : "0 0 0 0 transparent"
	const neuButtonHoverHighlight = neumorphic ? `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 20 : 14}%, transparent)` : "0 0 0 0 transparent"
	const neuButtonHoverShadow = neumorphic ? `0 1px 3px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 25 : 18}%, transparent)` : "0 0 0 0 transparent"
	const neuButtonActiveHighlight = neumorphic ? `inset 0 1px 0 0 color-mix(in srgb, white 35%, transparent)` : "0 0 0 0 transparent"
	const neuButtonActiveShadow = neumorphic ? `0 1px 3px 0 color-mix(in srgb, black 35%, transparent)` : "0 0 0 0 transparent"
	const neuWidgetHighlight = neumorphic ? `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} 12%, transparent)` : "0 0 0 0 transparent"
	const neuWidgetShadow = neumorphic ? `0 1px 2px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 17 : 12}%, transparent)` : "0 0 0 0 transparent"
	const neuTroughInset = neumorphic ? `inset 0 1px 2px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 15 : 10}%, transparent), inset 0 -1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 5 : 4}%, transparent)` : "0 0 0 0 transparent"
	const neuProgressHighlight = neumorphic ? `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 20 : 14}%, transparent)` : "0 0 0 0 transparent"
	const neuProgressShadow = neumorphic ? `0 1px 1px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 20 : 14}%, transparent)` : "0 0 0 0 transparent"
	const neuSliderHighlight = neumorphic ? `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 30 : 22}%, transparent)` : "0 0 0 0 transparent"
	const neuEntryInset = neumorphic ? `inset 0 2px 3px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 10 : 8}%, transparent), inset 0 -1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 5 : 4}%, transparent)` : "0 0 0 0 transparent"

	return [
		`--bg: ${backgroundColor};`,
		`--fg: ${pickThemeValue(theme.dark.fg, theme.light.fg)};`,
		`--primary-bg: ${primaryBackground};`,
		`--primary-fg: ${pickThemeValue(theme.dark.primary.fg, theme.light.primary.fg)};`,
		`--error-bg: ${pickThemeValue(theme.dark.error.bg, theme.light.error.bg)};`,
		`--error-fg: ${pickThemeValue(theme.dark.error.fg, theme.light.error.fg)};`,
		`--padding: ${paddingValue}pt;`,
		`--spacing: ${theme.spacing.peek()}pt;`,
		`--radius: ${radiusValue}px;`,
		`--transition: ${options.transition.duration.peek()}ms;`,
		`--border-width: ${theme.border.width.peek()}px;`,
		`--font-size: ${fontSize}pt;`,
		`--font-name: "${fontName}";`,
		`--screen-corner-radius: ${screenCornerRadius}px;`,
		`--popover-padding: ${paddingValue * 1.6}pt;`,
		`--popover-radius: ${radiusValue * 2}px;`,
		`--shadow-color: ${shadowColor};`,
		`--active-gradient: ${activeGradient};`,
		`--widget-bg: ${widgetBackground};`,
		`--hover-bg: ${hoverBackground};`,
		`--border-color: ${borderColor};`,
		`--popover-border-color: ${popoverBorderColor};`,
		`--neu-button-highlight: ${neuButtonHighlight};`,
		`--neu-button-shadow: ${neuButtonShadow};`,
		`--neu-button-hover-highlight: ${neuButtonHoverHighlight};`,
		`--neu-button-hover-shadow: ${neuButtonHoverShadow};`,
		`--neu-button-active-highlight: ${neuButtonActiveHighlight};`,
		`--neu-button-active-shadow: ${neuButtonActiveShadow};`,
		`--neu-widget-highlight: ${neuWidgetHighlight};`,
		`--neu-widget-shadow: ${neuWidgetShadow};`,
		`--neu-trough-inset: ${neuTroughInset};`,
		`--neu-progress-highlight: ${neuProgressHighlight};`,
		`--neu-progress-shadow: ${neuProgressShadow};`,
		`--neu-slider-highlight: ${neuSliderHighlight};`,
		`--neu-entry-inset: ${neuEntryInset};`,
	].join('\n')
}

export function resetCss() {
	if (!fileExists(cssFilePath)) {
		logError(new Error(`CSS file not found: ${cssFilePath}`))
		return
	}

	if (cssReloadTimeout) {
		cssReloadTimeout.cancel()
	}

	cssReloadTimeout = timeout(100, () => {
		const cssVariables = buildCssVariables()
		const runtimeCssPath = `${env.paths.tmp}runtime-vars.css`
		const runtimeCssContent = `* {\n${cssVariables}\n}\n`

		writeFileAsync(runtimeCssPath, runtimeCssContent).then(() => {
			idle(() => {
				app.apply_css(cssFilePath, false)
				app.apply_css(runtimeCssPath, false)
			})
		})

		cssReloadTimeout = undefined
	})
}

function onRecompile() {
	monitorFile(cssFilePath, () => {
		resetCss()
	})
}

export function initCss() {
	const configDir = GLib.getenv('AGS2SHELL_STYLES') ?? env.paths.cfg
	cssFilePath = GLib.build_filenamev([configDir, 'style', 'compile', 'main.css'])

	const optionDependencies = [
		"font",
		"theme",
		"theme.neumorphic",
		"bar.corners",
		"bar.position",
		"hyprland.gaps",
		"transition.duration"
	]

	setHandler(options, optionDependencies, resetCss)
	resetCss()

	onRecompile()
}
