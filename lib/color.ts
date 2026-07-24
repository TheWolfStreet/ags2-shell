// Chooses a wallpaper color and makes readable dark and light colors from it.

export type Rgb = {
	r: number
	g: number
	b: number
}

export type ThemeColors = {
	bg: string
	fg: string
	widget: string
	border: string
	primaryBg: string
	primaryFg: string
	errorBg: string
}

export type WallpaperPalette = {
	dominant: string
	hue: number
	chroma: number
	dark: ThemeColors
	light: ThemeColors
}

type Oklab = {
	l: number
	a: number
	b: number
}

type Oklch = {
	l: number
	c: number
	h: number
}

const HUE_BIN_COUNT = 24
const MIN_CHROMA = 0.025

function clamp(value: number, min = 0, max = 1) {
	return Math.min(max, Math.max(min, value))
}

function normalizeHue(hue: number) {
	return ((hue % 360) + 360) % 360
}

function hueDistance(a: number, b: number) {
	const distance = Math.abs(normalizeHue(a) - normalizeHue(b))
	return Math.min(distance, 360 - distance)
}

function srgbToLinear(channel: number) {
	return channel <= 0.04045
		? channel / 12.92
		: ((channel + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(channel: number) {
	return channel <= 0.0031308
		? channel * 12.92
		: 1.055 * channel ** (1 / 2.4) - 0.055
}

function rgbToOklab({ r, g, b }: Rgb): Oklab {
	const red = srgbToLinear(r)
	const green = srgbToLinear(g)
	const blue = srgbToLinear(b)
	const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
	const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
	const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)

	return {
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	}
}

function oklabToOklch({ l, a, b }: Oklab): Oklch {
	return {
		l,
		c: Math.hypot(a, b),
		h: normalizeHue(Math.atan2(b, a) * 180 / Math.PI),
	}
}

function linearRgbFromOklch({ l, c, h }: Oklch): Rgb {
	const radians = h * Math.PI / 180
	const a = c * Math.cos(radians)
	const b = c * Math.sin(radians)
	const lRoot = l + 0.3963377774 * a + 0.2158037573 * b
	const mRoot = l - 0.1055613458 * a - 0.0638541728 * b
	const sRoot = l - 0.0894841775 * a - 1.291485548 * b
	const lCube = lRoot ** 3
	const mCube = mRoot ** 3
	const sCube = sRoot ** 3

	return {
		r: 4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
		g: -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
		b: -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
	}
}

function inGamut({ r, g, b }: Rgb) {
	return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1
}

function oklchToRgb(color: Oklch): Rgb {
	let chroma = color.c
	let linear = linearRgbFromOklch(color)

	while (!inGamut(linear) && chroma > 0.001) {
		chroma *= 0.92
		linear = linearRgbFromOklch({ ...color, c: chroma })
	}

	return {
		r: clamp(linearToSrgb(clamp(linear.r))),
		g: clamp(linearToSrgb(clamp(linear.g))),
		b: clamp(linearToSrgb(clamp(linear.b))),
	}
}

function toHex({ r, g, b }: Rgb) {
	const channel = (value: number) => Math.round(clamp(value) * 255).toString(16).padStart(2, "0")
	return `#${channel(r)}${channel(g)}${channel(b)}`
}

function relativeLuminance({ r, g, b }: Rgb) {
	return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function contrastRatio(a: Rgb, b: Rgb) {
	const lighter = Math.max(relativeLuminance(a), relativeLuminance(b))
	const darker = Math.min(relativeLuminance(a), relativeLuminance(b))
	return (lighter + 0.05) / (darker + 0.05)
}

function colorAt(l: number, c: number, h: number) {
	return oklchToRgb({ l, c, h })
}

function readableText(background: Rgb, hue: number, tinted: boolean) {
	const black = { r: 0, g: 0, b: 0 }
	const white = { r: 1, g: 1, b: 1 }
	if (!tinted)
		return contrastRatio(background, black) >= contrastRatio(background, white) ? black : white

	const dark = colorAt(0.15, 0.012, hue)
	const light = colorAt(0.97, 0.008, hue)
	const darkContrast = contrastRatio(background, dark)
	const lightContrast = contrastRatio(background, light)
	const tintedText = darkContrast >= lightContrast ? dark : light
	if (Math.max(darkContrast, lightContrast) >= 4.5) return tintedText

	return contrastRatio(background, black) >= contrastRatio(background, white) ? black : white
}

function buildTheme(hue: number, accentChroma: number, dark: boolean): ThemeColors {
	const surfaceChroma = Math.min(0.018, accentChroma * 0.15)
	const borderChroma = Math.min(0.035, accentChroma * 0.28)
	const bg = colorAt(dark ? 0.15 : 0.98, surfaceChroma, hue)
	const fg = colorAt(dark ? 0.93 : 0.2, Math.min(0.015, surfaceChroma), hue)
	const border = colorAt(dark ? 0.58 : 0.48, borderChroma, hue)
	const primaryLightness = accentChroma === 0 ? (dark ? 0.88 : 0.28) : (dark ? 0.74 : 0.59)
	const primaryBg = colorAt(primaryLightness, accentChroma, hue)
	const errorBg = colorAt(dark ? 0.68 : 0.53, 0.17, 25)

	return {
		bg: toHex(bg),
		fg: toHex(fg),
		widget: toHex(fg),
		border: toHex(border),
		primaryBg: toHex(primaryBg),
		primaryFg: toHex(readableText(primaryBg, hue, accentChroma > 0)),
		errorBg: toHex(errorBg),
	}
}

function dominantHue(labs: Oklch[]) {
	const binScores = Array.from({ length: HUE_BIN_COUNT }, () => 0)
	const binSize = 360 / HUE_BIN_COUNT

	for (const color of labs) {
		if (color.c < MIN_CHROMA || color.l < 0.08 || color.l > 0.96) continue
		const bin = Math.floor(color.h / binSize) % HUE_BIN_COUNT
		const chromaWeight = 0.65 + 0.35 * Math.min(color.c / 0.18, 1)
		const toneWeight = 0.75 + 0.25 * (1 - Math.min(Math.abs(color.l - 0.6) / 0.6, 1))
		binScores[bin] += chromaWeight * toneWeight
	}

	const smoothed = binScores.map((_, bin) => {
		return [-2, -1, 0, 1, 2].reduce((score, offset) => {
			const neighbor = (bin + offset + HUE_BIN_COUNT) % HUE_BIN_COUNT
			const weight = offset === 0 ? 1 : Math.abs(offset) === 1 ? 0.7 : 0.35
			return score + binScores[neighbor] * weight
		}, 0)
	})
	const bestScore = Math.max(...smoothed)
	if (bestScore <= 0) return null

	const bestBin = smoothed.indexOf(bestScore)
	return (bestBin + 0.5) * binSize
}

function percentile(values: number[], position: number) {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * position)))
	return sorted[index]
}

export function buildWallpaperPalette(pixels: readonly Rgb[]): WallpaperPalette | null {
	if (pixels.length === 0) return null

	const labs = pixels.map(rgbToOklab).map(oklabToOklch)
	const global = labs.reduce((sum, color) => ({
		l: sum.l + color.l,
		a: sum.a + color.c * Math.cos(color.h * Math.PI / 180),
		b: sum.b + color.c * Math.sin(color.h * Math.PI / 180),
	}), { l: 0, a: 0, b: 0 })
	const globalHue = normalizeHue(Math.atan2(global.b, global.a) * 180 / Math.PI)
	const targetHue = dominantHue(labs) ?? globalHue

	let hueX = 0
	let hueY = 0
	let sourceLightness = 0
	let sourceChroma = 0
	let totalWeight = 0
	const selectedChromas: number[] = []

	for (const color of labs) {
		const distance = hueDistance(color.h, targetHue)
		if (color.c < MIN_CHROMA || distance > 42) continue
		const proximity = 1 - distance / 42
		const weight = (0.6 + 0.4 * Math.min(color.c / 0.18, 1)) * (0.4 + 0.6 * proximity)
		const radians = color.h * Math.PI / 180
		hueX += Math.cos(radians) * weight
		hueY += Math.sin(radians) * weight
		sourceLightness += color.l * weight
		sourceChroma += color.c * weight
		totalWeight += weight
		selectedChromas.push(color.c)
	}

	const hue = totalWeight > 0
		? normalizeHue(Math.atan2(hueY, hueX) * 180 / Math.PI)
		: globalHue
	const meanChroma = totalWeight > 0 ? sourceChroma / totalWeight : Math.hypot(global.a, global.b) / pixels.length
	const sampledChroma = Math.max(meanChroma, percentile(selectedChromas, 0.9))
	const sampledLightness = totalWeight > 0 ? sourceLightness / totalWeight : global.l / pixels.length
	const chromaticCoverage = selectedChromas.length / pixels.length
	const isNeutral = sampledChroma < 0.04 || chromaticCoverage < 0.005
	const paletteHue = isNeutral ? 0 : hue
	const accentChroma = isNeutral ? 0 : clamp(sampledChroma * 1.2, 0.06, 0.17)
	const dominant = colorAt(clamp(sampledLightness, 0.35, 0.82), isNeutral ? 0 : sampledChroma, paletteHue)

	return {
		dominant: toHex(dominant),
		hue: paletteHue,
		chroma: sampledChroma,
		dark: buildTheme(paletteHue, accentChroma, true),
		light: buildTheme(paletteHue, accentChroma, false),
	}
}
