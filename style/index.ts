import app from "ags/gtk4/app"
import { writeFile } from "ags/file"

import GLib from "gi://GLib"

import { Opt, setHandler } from "$lib/option"
import { env } from "$lib/env"
import { bash, dependencies } from "$lib/utils"

import options from "options"

const deps = ["font", "theme", "bar.corners", "bar.position"]
const { dark, light, blur, blurOnLight, scheme, padding, spacing, radius, shadows, widget, border } = options.theme
const popoverPaddingMul = 1.6

const configDir = (() => {
	const devDir = GLib.getenv('AGS2SHELL_DEV')
	if (devDir && GLib.file_test(devDir, GLib.FileTest.IS_DIR)) return devDir

	const url = import.meta.url
	if (url.startsWith('file://')) {
		const unescaped = GLib.uri_unescape_string(url.slice(7), null)
		if (!unescaped) throw new Error("Failed to unescape url")
		const dir = GLib.path_get_dirname(unescaped)
		const nixShared = GLib.build_filenamev([dir, '..', 'share'])
		if (GLib.file_test(nixShared, GLib.FileTest.IS_DIR)) return nixShared
	}

	const cfg = GLib.build_filenamev([env.paths.cfg])
	if (GLib.file_test(cfg, GLib.FileTest.IS_DIR)) return cfg
	return ''
})()

const value = <T>(v: Opt<T> | T): T =>
	v instanceof Opt ? v.get() : v

const t = <T>(dark_val: Opt<T> | T, light_val: Opt<T> | T): T =>
	value(scheme.get().includes("dark") ? dark_val : light_val)

const $ = (name: string, val: string | Opt<any>) =>
	`$${name}: ${value(val)};`

const variables = () => {
	const is_dark = scheme.get().includes("dark")
	const blur_level = blur.get()
	const bg = blur_level && (is_dark || blurOnLight.get())
		? `transparentize(${t(dark.bg, light.bg)}, ${blur_level / 100})`
		: t(dark.bg, light.bg)

	return [
		'@use "sass:color";',
		$("bg", bg), $("fg", t(dark.fg, light.fg)),
		$("primary-bg", t(dark.primary.bg, light.primary.bg)),
		$("primary-fg", t(dark.primary.fg, light.primary.fg)),
		$("error-bg", t(dark.error.bg, light.error.bg)),
		$("error-fg", t(dark.error.fg, light.error.fg)),
		$("scheme", scheme),
		$("padding", `${padding.get()}pt`),
		$("spacing", `${spacing.get()}pt`),
		$("radius", `${radius.get()}px`),
		$("transition", `${options.transition.duration.get()}ms`),
		$("shadows", `${shadows.get()}`),
		$("widget-bg", `transparentize(${t(dark.widget, light.widget)}, ${widget.opacity.get() / 100})`),
		$("hover-bg", `transparentize(${t(dark.widget, light.widget)}, ${(widget.opacity.get() * 0.9) / 100})`),
		$("hover-fg", `lighten(${t(dark.fg, light.fg)}, 8%)`),
		$("border-width", `${border.width.get()}px`),
		$("border-color", `transparentize(${t(dark.border, light.border)}, ${border.opacity.get() / 100})`),
		$("border", "$border-width solid $border-color"),
		$("active-gradient", `linear-gradient(to right, ${t(dark.primary.bg, light.primary.bg)}, darken(${t(dark.primary.bg, light.primary.bg)}, 4%))`),
		$("shadow-color", t("rgba(0,0,0,.6)", "rgba(0,0,0,.4)")),
		$("text-shadow", t("2pt 2pt 2pt $shadow-color", "none")),
		$("box-shadow", t("2pt 2pt 2pt 0 $shadow-color, inset 0 0 0 $border-width $border-color", "none")),
		$("popover-border-color", `transparentize(${t(dark.border, light.border)}, ${Math.max((border.opacity.get() - 1) / 100, 0)})`),
		$("popover-padding", `$padding * ${popoverPaddingMul}`),
		$("popover-radius", radius.get() === 0 ? "0" : "$radius + $popover-padding"),
		$("font-size", `${options.font.size.get()}pt`),
		$("font-name", options.font.name.get()),
		$("bar-position", options.bar.position.get()),
		$("hyprland-gaps-multiplier", options.hyprland.gaps),
		$("screen-corner-multiplier", `${options.bar.corners.get() * 0.01}`),
	]
}

export async function resetCss() {
	if (!dependencies("sass", "fd")) return
	try {
		const vars = `${env.paths.tmp}/variables.scss`
		const scss = `${env.paths.tmp}/main.scss`
		const css = `${env.paths.tmp}/main.css`
		const files = (await bash(`fd ".scss" ${configDir}`)).split(/\s+/)
		writeFile(vars, variables().join("\n"))
		writeFile(scss, [`@import '${vars}';`, ...files.map(f => `@import '${f}';`)].join("\n"))
		await bash`sass ${scss} ${css}`
		app.apply_css(css, true)
	} catch (err) {
		logError(err)
	}
}

export async function initCss() {
	setHandler(options, deps, resetCss)
	await resetCss()
}
