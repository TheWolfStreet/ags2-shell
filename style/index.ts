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
	v instanceof Opt ? v.get() : v

const t = <T>(dark_val: Opt<T> | T, light_val: Opt<T> | T): T =>
	value(scheme.get().includes("dark") ? dark_val : light_val)

export function resetCss() {
	const css = GLib.build_filenamev([configDir, 'style', 'compile', 'main.css'])

	if (!fileExists(css)) {
		logError(new Error(`CSS file not found: ${css}`))
		return
	}

		const is_dark = scheme.get().includes("dark")
		const blur_level = blur.get()
		const bg = blur_level && (is_dark || blurOnLight.get())
			? `color-mix(in srgb, ${t(dark.bg, light.bg)} ${Math.round((1 - blur_level / 100) * 100)}%, transparent)`
			: t(dark.bg, light.bg)

		const gapsMultiplier = options.hyprland.gaps.get()
		const cornerMultiplier = options.bar.corners.get() * 0.01
		const screenCornerRadius = radius.get() * gapsMultiplier * cornerMultiplier
		const popoverPadding = padding.get() * popoverPaddingMul
		const popoverRadius = radius.get() + popoverPadding

		const shadowColor = shadows.get()
			? (is_dark ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.4)")
			: "transparent"

		const primaryBg = t(dark.primary.bg, light.primary.bg)

		const darkenColor = (color: string) => {
			const match = color.match(/^#([0-9a-f]{6})$/i)
			if (!match) return color
			const hex = match[1]
			const r = parseInt(hex.substr(0, 2), 16)
			const g = parseInt(hex.substr(2, 2), 16)
			const b = parseInt(hex.substr(4, 2), 16)
			const darker = (c: number) => Math.round(c * 0.96)
			return `#${[r, g, b].map(darker).map(c => c.toString(16).padStart(2, '0')).join('')}`
		}

		const activeGradient = `linear-gradient(to right, ${primaryBg}, ${darkenColor(primaryBg)})`

		const widgetColor = t(dark.widget, light.widget)
		const widgetBg = `color-mix(in srgb, ${widgetColor} ${100 - widget.opacity.get()}%, transparent)`
		const hoverBg = `color-mix(in srgb, ${widgetColor} ${100 - (widget.opacity.get() * 0.9)}%, transparent)`
		const borderColor = `color-mix(in srgb, ${t(dark.border, light.border)} ${100 - border.opacity.get()}%, transparent)`
		const popoverBorderColor = `color-mix(in srgb, ${t(dark.border, light.border)} ${100 - Math.max(border.opacity.get() - 1, 0)}%, transparent)`

		const runtimeVars = [
			`--bg: ${bg};`,
			`--fg: ${t(dark.fg, light.fg)};`,
			`--primary-bg: ${primaryBg};`,
			`--primary-fg: ${t(dark.primary.fg, light.primary.fg)};`,
			`--error-bg: ${t(dark.error.bg, light.error.bg)};`,
			`--error-fg: ${t(dark.error.fg, light.error.fg)};`,
			`--padding: ${padding.get()}pt;`,
			`--spacing: ${spacing.get()}pt;`,
			`--radius: ${radius.get()}px;`,
			`--transition: ${options.transition.duration.get()}ms;`,
			`--border-width: ${border.width.get()}px;`,
			`--font-size: ${options.font.size.get()}pt;`,
			`--font-name: ${options.font.name.get()};`,
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
