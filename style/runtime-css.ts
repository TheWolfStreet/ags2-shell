import Pango from "gi://Pango"

import { read_value } from "$lib/ui"
import options, { type Opt } from "$shell/options"

const { FontDescription, SCALE } = Pango

function pick_theme_value<T>(
	is_dark_mode: boolean,
	dark_value: Opt<T> | T,
	light_value: Opt<T> | T,
): T {
	return read_value(is_dark_mode ? dark_value : light_value)
}

function calculate_neumorphic_effects(
	enabled: boolean,
	is_dark_mode: boolean,
	fg_color: string,
	scale: number,
) {
	if (!enabled) {
		const transparent = "0 0 0 0 transparent"
		return {
			button_highlight: transparent,
			button_shadow: transparent,
			button_hover_highlight: transparent,
			button_hover_shadow: transparent,
			button_active_highlight: transparent,
			button_active_shadow: transparent,
			widget_highlight: transparent,
			widget_shadow: transparent,
			trough_inset: transparent,
			progress_highlight: transparent,
			progress_shadow: transparent,
			slider_highlight: transparent,
		}
	}

	const highlight_color = is_dark_mode ? "white" : fg_color
	const shadow_base_color = is_dark_mode ? "black" : fg_color
	const px = (value: number) => `${value * scale}px`

	return {
		button_highlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlight_color} ${is_dark_mode ? 15 : 10}%, transparent)`,
		button_shadow: `0 ${px(1)} ${px(2)} 0 color-mix(in srgb, ${shadow_base_color} ${is_dark_mode ? 20 : 14}%, transparent)`,
		button_hover_highlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlight_color} ${is_dark_mode ? 20 : 14}%, transparent)`,
		button_hover_shadow: `0 ${px(1)} ${px(3)} 0 color-mix(in srgb, ${shadow_base_color} ${is_dark_mode ? 25 : 18}%, transparent)`,
		button_active_highlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, white 35%, transparent)`,
		button_active_shadow: `0 ${px(1)} ${px(3)} 0 color-mix(in srgb, black 35%, transparent)`,
		widget_highlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlight_color} 12%, transparent)`,
		widget_shadow: `0 ${px(1)} ${px(2)} 0 color-mix(in srgb, ${shadow_base_color} ${is_dark_mode ? 17 : 12}%, transparent)`,
		trough_inset: `inset 0 ${px(1)} ${px(2)} 0 color-mix(in srgb, ${shadow_base_color} ${is_dark_mode ? 15 : 10}%, transparent), inset 0 ${px(-1)} 0 0 color-mix(in srgb, ${highlight_color} ${is_dark_mode ? 5 : 4}%, transparent)`,
		progress_highlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlight_color} ${is_dark_mode ? 20 : 14}%, transparent)`,
		progress_shadow: `0 ${px(1)} ${px(1)} 0 color-mix(in srgb, ${shadow_base_color} ${is_dark_mode ? 20 : 14}%, transparent)`,
		slider_highlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlight_color} ${is_dark_mode ? 30 : 22}%, transparent)`,
	}
}

type NeumorphicEffects = ReturnType<typeof calculate_neumorphic_effects>

type Palette = {
	bg: string
	fg: string
	widget_bg: string
	hover_bg: string
	border: string
	popover_border: string
	primary_bg: string
	primary_fg: string
	error_bg: string
	active_gradient: string
	shadow: string
	shades: {
		headerbar: string
		headerbar_darker: string
		sidebar: string
		secondary_sidebar: string
		scrollbar_outline: string
		shade: string
	}
}

type LayoutVars = {
	padding: number
	spacing: number
	radius: number
	transition_duration: number
	border_width: number
	font_size: number
	icon_size: number
	scale: number
	font_name: string
	screen_corner_radius: number
}

function color_mix(color: string, opacity_percent: number): string {
	return `color-mix(in srgb, ${color} ${opacity_percent}%, transparent)`
}

function darken_hex_color(hex_color: string): string {
	const hex_match = hex_color.match(/^#([0-9a-f]{6})$/i)
	if (!hex_match) return hex_color

	const hex = hex_match[1]
	const r = parseInt(hex.substring(0, 2), 16)
	const g = parseInt(hex.substring(2, 4), 16)
	const b = parseInt(hex.substring(4, 6), 16)
	const darken = (channel: number) => Math.round(channel * 0.96)
	const to_hex = (channel: number) => channel.toString(16).padStart(2, "0")

	return `#${[r, g, b].map(darken).map(to_hex).join("")}`
}

function shadow_color(enabled: boolean, is_dark_mode: boolean): string {
	if (!enabled) return "transparent"

	return is_dark_mode ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.4)"
}

function compute_palette(is_dark_mode: boolean): Palette {
	const theme = options.theme
	const opacity = theme.opacity.peek()
	const effective_opacity = is_dark_mode ? opacity : opacity / 2
	const base_bg = pick_theme_value(is_dark_mode, theme.dark.bg, theme.light.bg)
	const bg =
		opacity > 0
			? color_mix(base_bg, Math.round((1 - effective_opacity / 100) * 100))
			: base_bg
	const primary_bg = pick_theme_value(
		is_dark_mode,
		theme.dark.primary.bg,
		theme.light.primary.bg,
	)
	const primary_fg = pick_theme_value(
		is_dark_mode,
		theme.dark.primary.fg,
		theme.light.primary.fg,
	)
	const widget_base = pick_theme_value(
		is_dark_mode,
		theme.dark.widget,
		theme.light.widget,
	)
	const widget_opacity = theme.widget.opacity.peek()
	const border_base = pick_theme_value(
		is_dark_mode,
		theme.dark.border,
		theme.light.border,
	)
	const border_opacity = theme.border.opacity.peek()
	const fg = pick_theme_value(is_dark_mode, theme.dark.fg, theme.light.fg)

	return {
		bg,
		fg,
		widget_bg: color_mix(widget_base, 100 - widget_opacity),
		hover_bg: color_mix(widget_base, 100 - widget_opacity * 0.9),
		border: color_mix(border_base, 100 - border_opacity),
		popover_border: color_mix(
			border_base,
			100 - Math.max(border_opacity - 1, 0),
		),
		primary_bg: primary_bg,
		primary_fg: primary_fg,
		error_bg: pick_theme_value(
			is_dark_mode,
			theme.dark.error.bg,
			theme.light.error.bg,
		),
		active_gradient: `linear-gradient(to right, ${primary_bg}, ${darken_hex_color(primary_bg)})`,
		shadow: shadow_color(theme.shadows.peek(), is_dark_mode),
		shades: {
			headerbar: color_mix(fg, 12),
			headerbar_darker: color_mix(fg, 18),
			sidebar: color_mix(fg, 10),
			secondary_sidebar: color_mix(fg, 8),
			scrollbar_outline: color_mix(fg, 30),
			shade: color_mix(fg, 15),
		},
	}
}

function compute_layout(): LayoutVars {
	const theme = options.theme
	const scale = Math.max(0.1, options.scale.peek() / 100)
	const radius = theme.roundness.peek() * scale
	const font_desc = FontDescription.from_string(String(options.font.peek()))
	const base_font_size = Math.round(font_desc.get_size() / SCALE) || 11

	return {
		padding: theme.padding.peek() * scale,
		spacing: theme.spacing.peek() * scale,
		radius,
		transition_duration: options.transition.duration.peek(),
		border_width: theme.border.width.peek() * scale,
		font_size: Math.max(1, Math.round(base_font_size * scale)),
		icon_size: Math.max(8, Math.round(16 * scale)),
		scale,
		font_name: font_desc.get_family() || "Sans",
		screen_corner_radius:
			radius * options.hyprland.gaps.peek() * options.bar.corners.peek() * 0.01,
	}
}

function build_gtk_color_definitions(p: Palette): string {
	return [
		`@define-color window_bg_color ${p.bg};`,
		`@define-color window_fg_color ${p.fg};`,
		`@define-color view_bg_color ${p.bg};`,
		`@define-color view_fg_color ${p.fg};`,
		`@define-color card_bg_color ${p.widget_bg};`,
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
		`@define-color headerbar_darker_shade_color ${p.shades.headerbar_darker};`,
		"",
		`@define-color sidebar_bg_color ${p.widget_bg};`,
		`@define-color sidebar_fg_color ${p.fg};`,
		`@define-color sidebar_backdrop_color ${p.widget_bg};`,
		`@define-color sidebar_shade_color ${p.shades.sidebar};`,
		`@define-color sidebar_border_color ${p.border};`,
		"",
		`@define-color secondary_sidebar_bg_color ${p.bg};`,
		`@define-color secondary_sidebar_fg_color ${p.fg};`,
		`@define-color secondary_sidebar_backdrop_color ${p.bg};`,
		`@define-color secondary_sidebar_shade_color ${p.shades.secondary_sidebar};`,
		`@define-color secondary_sidebar_border_color ${p.border};`,
		"",
		`@define-color accent_bg_color ${p.primary_bg};`,
		`@define-color accent_fg_color ${p.primary_fg};`,
		`@define-color accent_color ${p.primary_bg};`,
		"",
		`@define-color scrollbar_outline_color ${p.shades.scrollbar_outline};`,
		`@define-color shade_color ${p.shades.shade};`,
		`@define-color shadow_color ${p.shadow};`,
	].join("\n")
}

function build_custom_properties(
	p: Palette,
	layout: LayoutVars,
	neu: NeumorphicEffects,
): string {
	return [
		`--bg: ${p.bg};`,
		`--fg: ${p.fg};`,
		`--primary-bg: ${p.primary_bg};`,
		`--primary-fg: ${p.primary_fg};`,
		`--error-bg: ${p.error_bg};`,
		`--padding: ${layout.padding}pt;`,
		`--spacing: ${layout.spacing}pt;`,
		`--radius: ${layout.radius}px;`,
		`--transition: ${layout.transition_duration}ms;`,
		`--border-width: ${layout.border_width}px;`,
		`--font-size: ${layout.font_size}pt;`,
		`--icon-size: ${layout.icon_size}px;`,
		`--scale: ${layout.scale};`,
		`--font-name: "${layout.font_name}";`,
		`--screen-corner-radius: ${layout.screen_corner_radius}px;`,
		`--popover-padding: ${layout.padding * 1.6}pt;`,
		`--popover-radius: ${layout.radius * 2}px;`,
		`--ui-padding: ${layout.padding}pt;`,
		`--ui-spacing: ${layout.spacing}pt;`,
		`--ui-radius: ${layout.radius}px;`,
		`--ui-border-width: ${layout.border_width}px;`,
		`--ui-font-size: ${layout.font_size}pt;`,
		`--ui-icon-size: ${layout.icon_size}px;`,
		`--ui-popover-padding: ${layout.padding * 1.6}pt;`,
		`--ui-popover-radius: ${layout.radius * 2}px;`,
		`--shadow-color: ${p.shadow};`,
		`--active-gradient: ${p.active_gradient};`,
		`--widget-bg: ${p.widget_bg};`,
		`--hover-bg: ${p.hover_bg};`,
		`--border-color: ${p.border};`,
		`--popover-border-color: ${p.popover_border};`,
		`--neu-button-highlight: ${neu.button_highlight};`,
		`--neu-button-shadow: ${neu.button_shadow};`,
		`--neu-button-hover-highlight: ${neu.button_hover_highlight};`,
		`--neu-button-hover-shadow: ${neu.button_hover_shadow};`,
		`--neu-button-active-highlight: ${neu.button_active_highlight};`,
		`--neu-button-active-shadow: ${neu.button_active_shadow};`,
		`--neu-widget-highlight: ${neu.widget_highlight};`,
		`--neu-widget-shadow: ${neu.widget_shadow};`,
		`--neu-trough-inset: ${neu.trough_inset};`,
		`--neu-progress-highlight: ${neu.progress_highlight};`,
		`--neu-progress-shadow: ${neu.progress_shadow};`,
		`--neu-slider-highlight: ${neu.slider_highlight};`,
	].join("\n")
}

export function build_runtime_css(): string {
	const is_dark_mode = options.theme.scheme.peek() === "dark"
	const palette = compute_palette(is_dark_mode)
	const layout = compute_layout()
	const neu = calculate_neumorphic_effects(
		options.theme.neumorphic.peek() && options.theme.shadows.peek(),
		is_dark_mode,
		palette.fg,
		layout.scale,
	)
	const definitions = build_gtk_color_definitions(palette)
	const properties = build_custom_properties(palette, layout, neu)

	return `${definitions}\n\n* {\n${properties}\n}\n`
}
