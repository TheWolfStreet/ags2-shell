import Pango from "gi://Pango"

import options from "$shell/options"

const { FontDescription, SCALE } = Pango

function neumorphic_shadows(
	is_dark_mode: boolean,
	fg_color: string,
	scale: number,
) {
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

type neumorphic_effects = ReturnType<typeof neumorphic_shadows>

function calculate_neumorphic_effects(
	enabled: boolean,
	is_dark_mode: boolean,
	fg_color: string,
	scale: number,
): neumorphic_effects {
	const shadows = neumorphic_shadows(is_dark_mode, fg_color, scale)
	if (enabled) return shadows
	const flat = Object.keys(shadows).map((name) => [name, "0 0 0 0 transparent"])
	return Object.fromEntries(flat) as neumorphic_effects
}

type palette = {
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

type layout_vars = {
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

function compute_palette(is_dark_mode: boolean): palette {
	const theme = options.theme
	const colors = is_dark_mode ? theme.dark : theme.light
	const opacity = theme.opacity.peek()
	const effective_opacity = is_dark_mode ? opacity : opacity / 2
	const base_bg = colors.bg.peek()
	const bg =
		opacity > 0
			? color_mix(base_bg, Math.round((1 - effective_opacity / 100) * 100))
			: base_bg
	const primary_bg = colors.primary.bg.peek()
	const widget_base = colors.widget.peek()
	const widget_opacity = theme.widget.opacity.peek()
	const border_base = colors.border.peek()
	const border_opacity = theme.border.opacity.peek()
	const fg = colors.fg.peek()

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
		primary_bg,
		primary_fg: colors.primary.fg.peek(),
		error_bg: colors.error.bg.peek(),
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

function compute_layout(): layout_vars {
	const theme = options.theme
	const scale = options.scale.peek() / 100
	const radius = theme.roundness.peek() * scale
	const font_desc = FontDescription.from_string(options.font.peek())
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

function build_gtk_color_definitions(p: palette): string {
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

const scalable_tokens = {
	padding: (layout: layout_vars) => `${layout.padding}pt`,
	spacing: (layout: layout_vars) => `${layout.spacing}pt`,
	radius: (layout: layout_vars) => `${layout.radius}px`,
	"border-width": (layout: layout_vars) => `${layout.border_width}px`,
	"font-size": (layout: layout_vars) => `${layout.font_size}pt`,
	"icon-size": (layout: layout_vars) => `${layout.icon_size}px`,
	"popover-padding": (layout: layout_vars) => `${layout.padding * 1.6}pt`,
	"popover-radius": (layout: layout_vars) => `${layout.radius * 2}px`,
}

function scalable_token_properties(layout: layout_vars, prefix: string) {
	return Object.entries(scalable_tokens).map(
		([name, value]) => `--${prefix}${name}: ${value(layout)};`,
	)
}

export function scaled_token_overrides(scale: number): string {
	return Object.keys(scalable_tokens)
		.map((name) => `--${name}: calc(var(--ui-${name}) * ${scale});`)
		.join("")
}

function neumorphic_properties(neu: neumorphic_effects) {
	return Object.entries(neu).map(
		([name, value]) => `--neu-${name.replaceAll("_", "-")}: ${value};`,
	)
}

function build_custom_properties(
	p: palette,
	layout: layout_vars,
	neu: neumorphic_effects,
): string {
	return [
		`--bg: ${p.bg};`,
		`--fg: ${p.fg};`,
		`--primary-bg: ${p.primary_bg};`,
		`--primary-fg: ${p.primary_fg};`,
		`--error-bg: ${p.error_bg};`,
		...scalable_token_properties(layout, ""),
		...scalable_token_properties(layout, "ui-"),
		`--transition: ${layout.transition_duration}ms;`,
		`--scale: ${layout.scale};`,
		`--font-name: "${layout.font_name}";`,
		`--screen-corner-radius: ${layout.screen_corner_radius}px;`,
		`--shadow-color: ${p.shadow};`,
		`--active-gradient: ${p.active_gradient};`,
		`--widget-bg: ${p.widget_bg};`,
		`--hover-bg: ${p.hover_bg};`,
		`--border-color: ${p.border};`,
		`--popover-border-color: ${p.popover_border};`,
		...neumorphic_properties(neu),
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
