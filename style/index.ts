import app from "ags/gtk4/app"
import { writeFileAsync, monitorFile } from "ags/file"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import env from "$lib/env"
import { Opt, setHandler } from "$lib/option"
import { fileExists } from "$lib/utils"
import options from "options"

let cssFilePath = ''

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
	const theme = options.theme;
	const isDarkMode = theme.scheme.peek().includes("dark");

	// Background with opacity blending
	const opacity = theme.opacity.peek();
	const baseBg = pickThemeValue(theme.dark.bg, theme.light.bg);
	const bgColor = opacity > 0
		? colorMix(baseBg, Math.round((1 - opacity / 100) * 100))
		: baseBg;

	// Layout metrics
	const radius = theme.radius.peek();
	const padding = theme.padding.peek();
	const gapsScale = options.hyprland.gaps.peek();
	const cornerScale = options.bar.corners.peek() * 0.01;
	const screenCornerRadius = radius * gapsScale * cornerScale;

	// Shadow configuration
	const useShadows = theme.shadows.peek();
	const shadowColor = useShadows
		? (isDarkMode ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.4)")
		: "transparent";

	// Primary/accent colors
	const primaryBg = pickThemeValue(theme.dark.primary.bg, theme.light.primary.bg);
	const primaryFg = pickThemeValue(theme.dark.primary.fg, theme.light.primary.fg);
	const activeGradient = `linear-gradient(to right, ${primaryBg}, ${darkenHexColor(primaryBg)})`;

	// Widget colors with opacity
	const widgetBaseColor = pickThemeValue(theme.dark.widget, theme.light.widget);
	const widgetOpacity = theme.widget.opacity.peek();
	const widgetBg = colorMix(widgetBaseColor, 100 - widgetOpacity);
	const hoverBg = colorMix(widgetBaseColor, 100 - (widgetOpacity * 0.9));

	// Border colors with opacity
	const borderBaseColor = pickThemeValue(theme.dark.border, theme.light.border);
	const borderOpacity = theme.border.opacity.peek();
	const borderColor = colorMix(borderBaseColor, 100 - borderOpacity);
	const popoverBorderColor = colorMix(borderBaseColor, 100 - Math.max(borderOpacity - 1, 0));

	// Font configuration
	const fontDesc = Pango.FontDescription.from_string(String(options.font.peek()));
	const fontName = fontDesc.get_family() || "Sans";
	const fontSize = Math.round(fontDesc.get_size() / Pango.SCALE) || 11;

	// Foreground and derived colors
	const fgColor = pickThemeValue(theme.dark.fg, theme.light.fg);
	const headerbarShade = colorMix(fgColor, 12);
	const headerbarDarkerShade = colorMix(fgColor, 18);
	const sidebarShade = colorMix(fgColor, 10);
	const secondarySidebarShade = colorMix(fgColor, 8);
	const scrollbarOutline = colorMix(fgColor, 30);
	const shadeColor = colorMix(fgColor, 15);

	// Error colors
	const errorBg = pickThemeValue(theme.dark.error.bg, theme.light.error.bg);
	const errorFg = pickThemeValue(theme.dark.error.fg, theme.light.error.fg);

	// Neumorphic effect calculations
	const neumorphicEffects = calculateNeumorphicEffects(theme.neumorphic.peek(), isDarkMode, fgColor);

	const cssVariables = [
		buildGtkColorDefinitions(bgColor, fgColor, widgetBg, borderColor, primaryBg, primaryFg, headerbarShade, headerbarDarkerShade, sidebarShade, secondarySidebarShade, scrollbarOutline, shadeColor, shadowColor),
		"",
		buildCustomProperties(bgColor, fgColor, primaryBg, primaryFg, errorBg, errorFg, padding, theme.spacing.peek(), radius, options.transition.duration.peek(), theme.border.width.peek(), fontSize, fontName, screenCornerRadius, shadowColor, activeGradient, widgetBg, hoverBg, borderColor, popoverBorderColor, neumorphicEffects),
	];

	return cssVariables.join('\n');
}

function calculateNeumorphicEffects(enabled: boolean, isDarkMode: boolean, fgColor: string) {
	if (!enabled) {
		const transparent = "0 0 0 0 transparent";
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
			entryInset: transparent,
		};
	}

	const highlightColor = isDarkMode ? "white" : fgColor;
	const shadowBaseColor = isDarkMode ? "black" : fgColor;

	return {
		buttonHighlight: `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 15 : 10}%, transparent)`,
		buttonShadow: `0 1px 2px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 20 : 14}%, transparent)`,
		buttonHoverHighlight: `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 20 : 14}%, transparent)`,
		buttonHoverShadow: `0 1px 3px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 25 : 18}%, transparent)`,
		buttonActiveHighlight: `inset 0 1px 0 0 color-mix(in srgb, white 35%, transparent)`,
		buttonActiveShadow: `0 1px 3px 0 color-mix(in srgb, black 35%, transparent)`,
		widgetHighlight: `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} 12%, transparent)`,
		widgetShadow: `0 1px 2px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 17 : 12}%, transparent)`,
		troughInset: `inset 0 1px 2px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 15 : 10}%, transparent), inset 0 -1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 5 : 4}%, transparent)`,
		progressHighlight: `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 20 : 14}%, transparent)`,
		progressShadow: `0 1px 1px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 20 : 14}%, transparent)`,
		sliderHighlight: `inset 0 1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 30 : 22}%, transparent)`,
		entryInset: `inset 0 2px 3px 0 color-mix(in srgb, ${shadowBaseColor} ${isDarkMode ? 10 : 8}%, transparent), inset 0 -1px 0 0 color-mix(in srgb, ${highlightColor} ${isDarkMode ? 5 : 4}%, transparent)`,
	};
}

function buildGtkColorDefinitions(
	bgColor: string,
	fgColor: string,
	widgetBg: string,
	borderColor: string,
	primaryBg: string,
	primaryFg: string,
	headerbarShade: string,
	headerbarDarkerShade: string,
	sidebarShade: string,
	secondarySidebarShade: string,
	scrollbarOutline: string,
	shadeColor: string,
	shadowColor: string
): string {
	const shadowColorRgba = shadowColor !== "transparent" ? shadowColor : "rgba(0, 0, 0, 0.6)";

	return [
		`@define-color window_bg_color ${bgColor};`,
		`@define-color window_fg_color ${fgColor};`,
		`@define-color view_bg_color ${bgColor};`,
		`@define-color view_fg_color ${fgColor};`,
		`@define-color card_bg_color ${widgetBg};`,
		`@define-color card_fg_color ${fgColor};`,
		`@define-color dialog_bg_color ${bgColor};`,
		`@define-color dialog_fg_color ${fgColor};`,
		`@define-color popover_bg_color ${bgColor};`,
		`@define-color popover_fg_color ${fgColor};`,
		"",
		`@define-color headerbar_bg_color ${bgColor};`,
		`@define-color headerbar_fg_color ${fgColor};`,
		`@define-color headerbar_border_color ${borderColor};`,
		`@define-color headerbar_backdrop_color ${bgColor};`,
		`@define-color headerbar_shade_color ${headerbarShade};`,
		`@define-color headerbar_darker_shade_color ${headerbarDarkerShade};`,
		"",
		`@define-color sidebar_bg_color ${widgetBg};`,
		`@define-color sidebar_fg_color ${fgColor};`,
		`@define-color sidebar_backdrop_color ${widgetBg};`,
		`@define-color sidebar_shade_color ${sidebarShade};`,
		`@define-color sidebar_border_color ${borderColor};`,
		"",
		`@define-color secondary_sidebar_bg_color ${bgColor};`,
		`@define-color secondary_sidebar_fg_color ${fgColor};`,
		`@define-color secondary_sidebar_backdrop_color ${bgColor};`,
		`@define-color secondary_sidebar_shade_color ${secondarySidebarShade};`,
		`@define-color secondary_sidebar_border_color ${borderColor};`,
		"",
		`@define-color accent_bg_color ${primaryBg};`,
		`@define-color accent_fg_color ${primaryFg};`,
		`@define-color accent_color ${primaryBg};`,
		"",
		`@define-color scrollbar_outline_color ${scrollbarOutline};`,
		`@define-color shade_color ${shadeColor};`,
		`@define-color shadow_color ${shadowColorRgba};`,
	].join('\n');
}

function buildCustomProperties(
	bgColor: string,
	fgColor: string,
	primaryBg: string,
	primaryFg: string,
	errorBg: string,
	errorFg: string,
	padding: number,
	spacing: number,
	radius: number,
	transitionDuration: number,
	borderWidth: number,
	fontSize: number,
	fontName: string,
	screenCornerRadius: number,
	shadowColor: string,
	activeGradient: string,
	widgetBg: string,
	hoverBg: string,
	borderColor: string,
	popoverBorderColor: string,
	neumorphic: any
): string {
	return [
		`--bg: ${bgColor};`,
		`--fg: ${fgColor};`,
		`--primary-bg: ${primaryBg};`,
		`--primary-fg: ${primaryFg};`,
		`--error-bg: ${errorBg};`,
		`--error-fg: ${errorFg};`,
		`--padding: ${padding}pt;`,
		`--spacing: ${spacing}pt;`,
		`--radius: ${radius}px;`,
		`--transition: ${transitionDuration}ms;`,
		`--border-width: ${borderWidth}px;`,
		`--font-size: ${fontSize}pt;`,
		`--font-name: "${fontName}";`,
		`--screen-corner-radius: ${screenCornerRadius}px;`,
		`--popover-padding: ${padding * 1.6}pt;`,
		`--popover-radius: ${radius * 2}px;`,
		`--shadow-color: ${shadowColor};`,
		`--active-gradient: ${activeGradient};`,
		`--widget-bg: ${widgetBg};`,
		`--hover-bg: ${hoverBg};`,
		`--border-color: ${borderColor};`,
		`--popover-border-color: ${popoverBorderColor};`,
		`--neu-button-highlight: ${neumorphic.buttonHighlight};`,
		`--neu-button-shadow: ${neumorphic.buttonShadow};`,
		`--neu-button-hover-highlight: ${neumorphic.buttonHoverHighlight};`,
		`--neu-button-hover-shadow: ${neumorphic.buttonHoverShadow};`,
		`--neu-button-active-highlight: ${neumorphic.buttonActiveHighlight};`,
		`--neu-button-active-shadow: ${neumorphic.buttonActiveShadow};`,
		`--neu-widget-highlight: ${neumorphic.widgetHighlight};`,
		`--neu-widget-shadow: ${neumorphic.widgetShadow};`,
		`--neu-trough-inset: ${neumorphic.troughInset};`,
		`--neu-progress-highlight: ${neumorphic.progressHighlight};`,
		`--neu-progress-shadow: ${neumorphic.progressShadow};`,
		`--neu-slider-highlight: ${neumorphic.sliderHighlight};`,
		`--neu-entry-inset: ${neumorphic.entryInset};`,
	].join('\n');
}

export function resetCss() {
	if (!fileExists(cssFilePath)) {
		logError(new Error(`CSS file not found: ${cssFilePath}`));
		return;
	}

	const cssVariables = buildCssVariables();
	const runtimeCssPath = `${env.paths.tmp}runtime-vars.css`;
	const lines = cssVariables.split('\n');
	const defineColors = lines.filter(line => line.startsWith('@define-color'));
	const cssVars = lines.filter(line => !line.startsWith('@define-color') && line.trim() !== '');
	const runtimeCssContent = `${defineColors.join('\n')}\n\n* {\n${cssVars.join('\n')}\n}\n`;

	writeFileAsync(runtimeCssPath, runtimeCssContent).then(() => {
		app.apply_css(cssFilePath, false);
		app.apply_css(runtimeCssPath, false);
	});
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
