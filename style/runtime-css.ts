// Converts saved appearance settings into CSS variables and widget styles.
import Pango from "gi://Pango"

import { Opt } from "$lib/option"
import options from "options"

const { FontDescription, SCALE } = Pango

function unwrapOption<T>(option: Opt<T> | T): T {
	return option instanceof Opt ? option.peek() : option
}

function pickThemeValue<T>(isDarkMode: boolean, darkValue: Opt<T> | T, lightValue: Opt<T> | T): T {
	return unwrapOption(isDarkMode ? darkValue : lightValue)
}

function calculateNeumorphicEffects(enabled: boolean, isDarkMode: boolean, fgColor: string, scale: number) {
	if (!enabled) {
		const transparent = "0 0 0 0 transparent"
		return {
			buttonHighlight: transparent,
			buttonShadow: transparent,
			buttonHoverHighlight: transparent,
			buttonHoverShadow: transparent,
			buttonActiveHighlight: transparent,
			buttonActiveShadow: transparent,
			widgetHighlight: transparent,
			widgetShadow: transparent,
			troughInset: transparent,
			progressHighlight: transparent,
			progressShadow: transparent,
			sliderHighlight: transparent,
		}
	}

	const highlightColor = isDarkMode ? "white" : fgColor
	const shadowBaseColor = isDarkMode ? "black" : fgColor
	const px = (value: number) => `${value * scale}px`

	return {
		buttonHighlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 15 : 10}%, transparent)`,
		buttonShadow: `0 ${px(1)} ${px(2)} 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 20 : 14}%, transparent)`,
		buttonHoverHighlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 20 : 14}%, transparent)`,
		buttonHoverShadow: `0 ${px(1)} ${px(3)} 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 25 : 18}%, transparent)`,
		buttonActiveHighlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, white 35%, transparent)`,
		buttonActiveShadow: `0 ${px(1)} ${px(3)} 0 color-mix(in srgb, black 35%, transparent)`,
		widgetHighlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlightColor} 12%, transparent)`,
		widgetShadow: `0 ${px(1)} ${px(2)} 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 17 : 12}%, transparent)`,
		troughInset: `inset 0 ${px(1)} ${px(2)} 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 15 : 10}%, transparent), inset 0 ${px(-1)} 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 5 : 4}%, transparent)`,
		progressHighlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 20 : 14}%, transparent)`,
		progressShadow: `0 ${px(1)} ${px(1)} 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 20 : 14}%, transparent)`,
		sliderHighlight: `inset 0 ${px(1)} 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 30 : 22}%, transparent)`,
	}
}

type NeumorphicEffects = ReturnType<typeof calculateNeumorphicEffects>

export type Palette = {
	bg: string
	fg: string
	widgetBg: string
	hoverBg: string
	border: string
	popoverBorder: string
	primaryBg: string
	primaryFg: string
	errorBg: string
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

export type LayoutVars = {
	padding: number
	spacing: number
	radius: number
	transitionDuration: number
	borderWidth: number
	fontSize: number
	iconSize: number
	scale: number
	fontName: string
	screenCornerRadius: number
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

function shadowColor(enabled: boolean, isDarkMode: boolean): string {
	if (!enabled)
		return "transparent"

	return isDarkMode ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.4)"
}

function computePalette(isDarkMode: boolean): Palette {
	const theme = options.theme
	const opacity = theme.opacity.peek()
	const effectiveOpacity = isDarkMode ? opacity : opacity / 2
	const baseBg = pickThemeValue(isDarkMode, theme.dark.bg, theme.light.bg)
	const bg = opacity > 0
		? colorMix(baseBg, Math.round((1 - effectiveOpacity / 100) * 100))
		: baseBg
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
		activeGradient: `linear-gradient(to right, ${primaryBg}, ${darkenHexColor(primaryBg)})`,
		shadow: shadowColor(theme.shadows.peek(), isDarkMode),
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

function computeLayout(): LayoutVars {
	const theme = options.theme
	const scale = Math.max(0.1, options.scale.peek() / 100)
	const radius = theme.roundness.peek() * scale
	const fontDesc = FontDescription.from_string(String(options.font.peek()))
	const baseFontSize = Math.round(fontDesc.get_size() / SCALE) || 11

	return {
		padding: theme.padding.peek() * scale,
		spacing: theme.spacing.peek() * scale,
		radius,
		transitionDuration: options.transition.duration.peek(),
		borderWidth: theme.border.width.peek() * scale,
		fontSize: Math.max(1, Math.round(baseFontSize * scale)),
		iconSize: Math.max(8, Math.round(16 * scale)),
		scale,
		fontName: fontDesc.get_family() || "Sans",
		screenCornerRadius: radius * options.hyprland.gaps.peek() * options.bar.corners.peek() * 0.01,
	}
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
		`--padding: ${layout.padding}pt;`,
		`--spacing: ${layout.spacing}pt;`,
		`--radius: ${layout.radius}px;`,
		`--transition: ${layout.transitionDuration}ms;`,
		`--border-width: ${layout.borderWidth}px;`,
		`--font-size: ${layout.fontSize}pt;`,
		`--icon-size: ${layout.iconSize}px;`,
		`--scale: ${layout.scale};`,
		`--font-name: "${layout.fontName}";`,
		`--screen-corner-radius: ${layout.screenCornerRadius}px;`,
		`--popover-padding: ${layout.padding * 1.6}pt;`,
		`--popover-radius: ${layout.radius * 2}px;`,
		`--ui-padding: ${layout.padding}pt;`,
		`--ui-spacing: ${layout.spacing}pt;`,
		`--ui-radius: ${layout.radius}px;`,
		`--ui-border-width: ${layout.borderWidth}px;`,
		`--ui-font-size: ${layout.fontSize}pt;`,
		`--ui-icon-size: ${layout.iconSize}px;`,
		`--ui-popover-padding: ${layout.padding * 1.6}pt;`,
		`--ui-popover-radius: ${layout.radius * 2}px;`,
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
	].join("\n")
}

export function buildRuntimeCss(): string {
	const isDarkMode = options.theme.scheme.peek().includes("dark")
	const palette = computePalette(isDarkMode)
	const layout = computeLayout()
	const neu = calculateNeumorphicEffects(options.theme.neumorphic.peek(), isDarkMode, palette.fg, layout.scale)
	const definitions = buildGtkColorDefinitions(palette)
	const properties = buildCustomProperties(palette, layout, neu)

	return `${definitions}\n\n* {\n${properties}\n}\n`
}
