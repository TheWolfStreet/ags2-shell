/* eslint-disable max-len */
import { App } from "astal/gtk3"
import { writeFile, GLib } from "astal"
import { type Opt } from "../lib/option"
import options from "../options"
import { bash, dependencies } from "../lib/utils"
import { env } from "../lib/environment"

const deps = [
	"font",
	"theme",
	"bar.corners",
	"bar.position",
]

const {
	dark,
	light,
	blur,
	blurOnLight,
	scheme,
	padding,
	spacing,
	radius,
	shadows,
	widget,
	border,
} = options.theme


const configDir = (() => {
	const url = import.meta.url;

	const devDir = GLib.getenv('AGS2SHELL_DEV');
	if (devDir) {
		if (GLib.file_test(devDir, GLib.FileTest.IS_DIR))
			return devDir;
	}

	if (url.startsWith('file://')) {
		const dir = GLib.path_get_dirname(GLib.uri_unescape_string(url.slice(7), null));
		const nixShared = GLib.build_filenamev([dir, '..', 'share']);
		if (GLib.file_test(nixShared, GLib.FileTest.IS_DIR)) {
			return nixShared;
		}
	}

	const cfg = GLib.build_filenamev([GLib.get_user_config_dir(), 'ags']);
	if (GLib.file_test(cfg, GLib.FileTest.IS_DIR))
		return cfg;

	return '';
})();

const popoverPaddingMul = 1.6

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t = (dark: Opt<any> | string, light: Opt<any> | string) => scheme.get() === "dark"
	? `${dark}` : `${light}`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const $ = (name: string, value: string | Opt<any>) => `$${name}: ${value};`

const variables = () => [
	"@use \"sass:color\";",
	$("bg", blur.get() &&
		(scheme(s => s.includes("dark")).get()
			? true
			: blurOnLight.get())
		? `transparentize(${t(dark.bg, light.bg)}, ${blur.get() / 100})` : t(dark.bg, light.bg)),
	$("fg", t(dark.fg, light.fg)),

	$("primary-bg", t(dark.primary.bg, light.primary.bg)),
	$("primary-fg", t(dark.primary.fg, light.primary.fg)),

	$("error-bg", t(dark.error.bg, light.error.bg)),
	$("error-fg", t(dark.error.fg, light.error.fg)),

	$("scheme", scheme),
	$("padding", `${padding}pt`),
	$("spacing", `${spacing}pt`),
	$("radius", `${radius}px`),
	$("transition", `${options.transition}ms`),

	$("shadows", `${shadows}`),

	$("widget-bg", `transparentize(${t(dark.widget, light.widget)}, ${widget.opacity.get() / 100})`),

	$("hover-bg", `transparentize(${t(dark.widget, light.widget)}, ${(widget.opacity.get() * .9) / 100})`),
	$("hover-fg", `lighten(${t(dark.fg, light.fg)}, 8%)`),

	$("border-width", `${border.width}px`),
	$("border-color", `transparentize(${t(dark.border, light.border)}, ${border.opacity.get() / 100})`),
	$("border", "$border-width solid $border-color"),

	$("active-gradient", `linear-gradient(to right, ${t(dark.primary.bg, light.primary.bg)}, darken(${t(dark.primary.bg, light.primary.bg)}, 4%))`),
	$("shadow-color", t("rgba(0,0,0,.6)", "rgba(0,0,0,.4)")),
	$("text-shadow", t("2pt 2pt 2pt $shadow-color", "none")),
	$("box-shadow", t("2pt 2pt 2pt 0 $shadow-color, inset 0 0 0 $border-width $border-color", "none")),

	$("popover-border-color", `transparentize(${t(dark.border, light.border)}, ${Math.max(((border.opacity.get() - 1) / 100), 0)})`),
	$("popover-padding", `$padding * ${popoverPaddingMul}`),
	$("popover-radius", radius.get() === 0 ? "0" : "$radius + $popover-padding"),

	$("font-size", `${options.font.size}pt`),
	$("font-name", options.font.name),

	$("bar-position", options.bar.position),
	$("hyprland-gaps-multiplier", options.hyprland.gaps),
	$("screen-corner-multiplier", `${options.bar.corners.get() * 0.01}`),
]

export async function resetCss() {
	if (!dependencies("sass", "fd")) return

	try {
		const vars = `${env.paths.tmp}/variables.scss`
		const scss = `${env.paths.tmp}/main.scss`
		const css = `${env.paths.tmp}/main.css`

		const fd = await bash(`fd ".scss" ${configDir}`)
		const files = fd.split(/\s+/)

		const imports = [
			`@import '${vars}';`,
			...files.map((f: string) => `@import '${f}';`)
		]

		writeFile(vars, variables().join("\n"))
		writeFile(scss, imports.join("\n"))
		await bash`sass ${scss} ${css}`

		App.apply_css(css, true)
	} catch (err) {
		logError(err)
	}
}
options.handler(deps, resetCss)
await resetCss()
