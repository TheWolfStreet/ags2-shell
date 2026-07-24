// Reads theme settings and calculates shadows and highlights.

import { Opt } from "$lib/option"

function unwrapOption<T>(option: Opt<T> | T): T {
	return option instanceof Opt ? option.peek() : option
}

export function pickThemeValue<T>(isDarkMode: boolean, darkValue: Opt<T> | T, lightValue: Opt<T> | T): T {
	return unwrapOption(isDarkMode ? darkValue : lightValue)
}

export type NeumorphicEffects = ReturnType<typeof calculateNeumorphicEffects>

export function calculateNeumorphicEffects(enabled: boolean, isDarkMode: boolean, fgColor: string) {
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
	}
}
