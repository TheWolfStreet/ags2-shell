import app from "ags/gtk4/app"
import { writeFileAsync } from "ags/file"

import GLib from "gi://GLib"

import env from "$lib/env"
import { Opt, setHandler } from "$lib/option"
import { fileExists } from "$lib/utils"

import options from "options"

const deps = ["font", "theme", "bar.corners", "bar.position", "hyprland.gaps", "transition.duration"]
const { dark, light, blur, blurOnLight, scheme, padding, spacing, radius, border, shadows, widget } = options.theme
const popoverPaddingMul = 1.6

const configDir = GLib.getenv('AGS2SHELL_STYLES') ?? env.paths.cfg

const value = <T>(v: Opt<T> | T): T =>
	v instanceof Opt ? v.peek() : v

const t = <T>(dark_val: Opt<T> | T, light_val: Opt<T> | T): T =>
	value(scheme.peek().includes("dark") ? dark_val : light_val)

export function resetCss() {
	const css = GLib.build_filenamev([configDir, 'style', 'compile', 'main.css'])

	if (!fileExists(css)) {
		logError(new Error(`CSS file not found: ${css}`))
		return
	}

		const is_dark = scheme.peek().includes("dark")
		const blur_level = blur.peek()
		const bg = blur_level && (is_dark || blurOnLight.peek())
			? `color-mix(in srgb, ${t(dark.bg, light.bg)} ${Math.round((1 - blur_level / 100) * 100)}%, transparent)`
			: t(dark.bg, light.bg)

		const gapsMultiplier = options.hyprland.gaps.peek()
		const cornerMultiplier = options.bar.corners.peek() * 0.01
		const screenCornerRadius = radius.peek() * gapsMultiplier * cornerMultiplier
		const popoverPadding = padding.peek() * popoverPaddingMul
		const popoverRadius = radius.peek() * 2

		const shadowColor = shadows.peek()
			? (is_dark ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.4)")
			: "transparent"

		const primaryBg = t(dark.primary.bg, light.primary.bg)

		const darkenColor = (color: string) => {
			const match = color.match(/^#([0-9a-f]{6})$/i)
			if (!match) return color
			const hex = match[1]
			const r = parseInt(hex.substring(0, 2), 16)
			const g = parseInt(hex.substring(2, 4), 16)
			const b = parseInt(hex.substring(4, 6), 16)
			const darker = (c: number) => Math.round(c * 0.96)
			return `#${[r, g, b].map(darker).map(c => c.toString(16).padStart(2, '0')).join('')}`
		}

		const activeGradient = `linear-gradient(to right, ${primaryBg}, ${darkenColor(primaryBg)})`

		const widgetColor = t(dark.widget, light.widget)
		const widgetBg = `color-mix(in srgb, ${widgetColor} ${100 - widget.opacity.peek()}%, transparent)`
		const hoverBg = `color-mix(in srgb, ${widgetColor} ${100 - (widget.opacity.peek() * 0.9)}%, transparent)`
		const borderColor = `color-mix(in srgb, ${t(dark.border, light.border)} ${100 - border.opacity.peek()}%, transparent)`
		const popoverBorderColor = `color-mix(in srgb, ${t(dark.border, light.border)} ${100 - Math.max(border.opacity.peek() - 1, 0)}%, transparent)`

		const fontString = String(options.font.peek())
		const fontSizeMatch = fontString.match(/(\d+)$/)
		const fontSize = fontSizeMatch ? fontSizeMatch[1] : "11"
		const fontName = fontString.replace(/\s+\d+$/, "").trim()

		const runtimeVars = [
			`--bg: ${bg};`,
			`--fg: ${t(dark.fg, light.fg)};`,
			`--primary-bg: ${primaryBg};`,
			`--primary-fg: ${t(dark.primary.fg, light.primary.fg)};`,
			`--error-bg: ${t(dark.error.bg, light.error.bg)};`,
			`--error-fg: ${t(dark.error.fg, light.error.fg)};`,
			`--padding: ${padding.peek()}pt;`,
			`--spacing: ${spacing.peek()}pt;`,
			`--radius: ${radius.peek()}px;`,
			`--transition: ${options.transition.duration.peek()}ms;`,
			`--border-width: ${border.width.peek()}px;`,
			`--font-size: ${fontSize}pt;`,
			`--font-name: ${fontName};`,
			`--screen-corner-radius: ${screenCornerRadius}px;`,
			`--popover-padding: ${popoverPadding}pt;`,
			`--popover-radius: ${popoverRadius}px;`,
			`--shadow-color: ${shadowColor};`,
			`--active-gradient: ${activeGradient};`,
			`--widget-bg: ${widgetBg};`,
			`--hover-bg: ${hoverBg};`,
			`--border-color: ${borderColor};`,
			`--popover-border-color: ${popoverBorderColor};`,
		].join('\n')

		const runtimeCss = `${env.paths.tmp}runtime-vars.css`
		writeFileAsync(runtimeCss, `* {\n${runtimeVars}\n}\n`).then(() => {
			GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
				app.apply_css(css, false)
				app.apply_css(runtimeCss, false)
				return GLib.SOURCE_REMOVE
			})
		})
	}

export function initCss() {
	setHandler(options, deps, resetCss)
	resetCss()
}
