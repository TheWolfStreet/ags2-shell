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
	primary_bg: string
	primary_fg: string
	error_bg: string
}

export type WallpaperPalette = {
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

function normalize_hue(hue: number) {
	return ((hue % 360) + 360) % 360
}

function hue_distance(a: number, b: number) {
	const distance = Math.abs(normalize_hue(a) - normalize_hue(b))
	return Math.min(distance, 360 - distance)
}

function srgb_to_linear(channel: number) {
	return channel <= 0.04045
		? channel / 12.92
		: ((channel + 0.055) / 1.055) ** 2.4
}

function linear_to_srgb(channel: number) {
	return channel <= 0.0031308
		? channel * 12.92
		: 1.055 * channel ** (1 / 2.4) - 0.055
}

function rgb_to_oklab({ r, g, b }: Rgb): Oklab {
	const red = srgb_to_linear(r)
	const green = srgb_to_linear(g)
	const blue = srgb_to_linear(b)
	const l = Math.cbrt(
		0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
	)
	const m = Math.cbrt(
		0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
	)
	const s = Math.cbrt(
		0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
	)

	return {
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	}
}

function oklab_to_oklch({ l, a, b }: Oklab): Oklch {
	return {
		l,
		c: Math.hypot(a, b),
		h: normalize_hue((Math.atan2(b, a) * 180) / Math.PI),
	}
}

function linear_rgb_from_oklch({ l, c, h }: Oklch): Rgb {
	const radians = (h * Math.PI) / 180
	const a = c * Math.cos(radians)
	const b = c * Math.sin(radians)
	const l_root = l + 0.3963377774 * a + 0.2158037573 * b
	const m_root = l - 0.1055613458 * a - 0.0638541728 * b
	const s_root = l - 0.0894841775 * a - 1.291485548 * b
	const l_cube = l_root ** 3
	const m_cube = m_root ** 3
	const s_cube = s_root ** 3

	return {
		r: 4.0767416621 * l_cube - 3.3077115913 * m_cube + 0.2309699292 * s_cube,
		g: -1.2684380046 * l_cube + 2.6097574011 * m_cube - 0.3413193965 * s_cube,
		b: -0.0041960863 * l_cube - 0.7034186147 * m_cube + 1.707614701 * s_cube,
	}
}

function in_gamut({ r, g, b }: Rgb) {
	return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1
}

function oklch_to_rgb(color: Oklch): Rgb {
	let chroma = color.c
	let linear = linear_rgb_from_oklch(color)

	while (!in_gamut(linear) && chroma > 0.001) {
		chroma *= 0.92
		linear = linear_rgb_from_oklch({ ...color, c: chroma })
	}

	return {
		r: clamp(linear_to_srgb(clamp(linear.r))),
		g: clamp(linear_to_srgb(clamp(linear.g))),
		b: clamp(linear_to_srgb(clamp(linear.b))),
	}
}

function to_hex({ r, g, b }: Rgb) {
	const channel = (value: number) =>
		Math.round(clamp(value) * 255)
			.toString(16)
			.padStart(2, "0")
	return `#${channel(r)}${channel(g)}${channel(b)}`
}

function relative_luminance({ r, g, b }: Rgb) {
	return (
		0.2126 * srgb_to_linear(r) +
		0.7152 * srgb_to_linear(g) +
		0.0722 * srgb_to_linear(b)
	)
}

function contrast_ratio(a: Rgb, b: Rgb) {
	const lighter = Math.max(relative_luminance(a), relative_luminance(b))
	const darker = Math.min(relative_luminance(a), relative_luminance(b))
	return (lighter + 0.05) / (darker + 0.05)
}

function color_at(l: number, c: number, h: number) {
	return oklch_to_rgb({ l, c, h })
}

function readable_text(background: Rgb, hue: number, tinted: boolean) {
	const black = { r: 0, g: 0, b: 0 }
	const white = { r: 1, g: 1, b: 1 }
	if (!tinted)
		return contrast_ratio(background, black) >=
			contrast_ratio(background, white)
			? black
			: white

	const dark = color_at(0.15, 0.012, hue)
	const light = color_at(0.97, 0.008, hue)
	const dark_contrast = contrast_ratio(background, dark)
	const light_contrast = contrast_ratio(background, light)
	const tinted_text = dark_contrast >= light_contrast ? dark : light
	if (Math.max(dark_contrast, light_contrast) >= 4.5) return tinted_text

	return contrast_ratio(background, black) >= contrast_ratio(background, white)
		? black
		: white
}

function build_theme(
	hue: number,
	accent_chroma: number,
	dark: boolean,
): ThemeColors {
	const surface_chroma = Math.min(0.018, accent_chroma * 0.15)
	const border_chroma = Math.min(0.035, accent_chroma * 0.28)
	const bg = color_at(dark ? 0.15 : 0.98, surface_chroma, hue)
	const fg = color_at(dark ? 0.93 : 0.2, Math.min(0.015, surface_chroma), hue)
	const border = color_at(dark ? 0.58 : 0.48, border_chroma, hue)
	let primary_lightness: number
	if (accent_chroma === 0) primary_lightness = dark ? 0.88 : 0.28
	else primary_lightness = dark ? 0.74 : 0.59
	const primary_bg = color_at(primary_lightness, accent_chroma, hue)
	const error_bg = color_at(dark ? 0.68 : 0.53, 0.17, 25)

	return {
		bg: to_hex(bg),
		fg: to_hex(fg),
		widget: to_hex(fg),
		border: to_hex(border),
		primary_bg: to_hex(primary_bg),
		primary_fg: to_hex(readable_text(primary_bg, hue, accent_chroma > 0)),
		error_bg: to_hex(error_bg),
	}
}

function dominant_hue(labs: Oklch[]) {
	const bin_scores = Array.from({ length: HUE_BIN_COUNT }, () => 0)
	const bin_size = 360 / HUE_BIN_COUNT

	for (const color of labs) {
		if (color.c < MIN_CHROMA || color.l < 0.08 || color.l > 0.96) continue
		const bin = Math.floor(color.h / bin_size) % HUE_BIN_COUNT
		const chroma_weight = 0.65 + 0.35 * Math.min(color.c / 0.18, 1)
		const tone_weight =
			0.75 + 0.25 * (1 - Math.min(Math.abs(color.l - 0.6) / 0.6, 1))
		bin_scores[bin] += chroma_weight * tone_weight
	}

	const smoothed = bin_scores.map((_score, bin) => {
		return [-2, -1, 0, 1, 2].reduce((score, offset) => {
			const neighbor = (bin + offset + HUE_BIN_COUNT) % HUE_BIN_COUNT
			let weight = 0.35
			if (offset === 0) weight = 1
			else if (Math.abs(offset) === 1) weight = 0.7
			return score + bin_scores[neighbor] * weight
		}, 0)
	})
	const best_score = Math.max(...smoothed)
	if (best_score <= 0) return null

	const best_bin = smoothed.indexOf(best_score)
	return (best_bin + 0.5) * bin_size
}

function percentile(values: number[], position: number) {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.floor((sorted.length - 1) * position)),
	)
	return sorted[index]
}

export function build_wallpaper_palette(
	pixels: readonly Rgb[],
): WallpaperPalette | null {
	if (pixels.length === 0) return null

	const labs = pixels.map(rgb_to_oklab).map(oklab_to_oklch)
	const global = labs.reduce(
		(sum, color) => ({
			a: sum.a + color.c * Math.cos((color.h * Math.PI) / 180),
			b: sum.b + color.c * Math.sin((color.h * Math.PI) / 180),
		}),
		{ a: 0, b: 0 },
	)
	const global_hue = normalize_hue(
		(Math.atan2(global.b, global.a) * 180) / Math.PI,
	)
	const target_hue = dominant_hue(labs) ?? global_hue

	let hue_x = 0
	let hue_y = 0
	let source_chroma = 0
	let total_weight = 0
	const selected_chromas: number[] = []

	for (const color of labs) {
		const distance = hue_distance(color.h, target_hue)
		if (color.c < MIN_CHROMA || distance > 42) continue
		const proximity = 1 - distance / 42
		const weight =
			(0.6 + 0.4 * Math.min(color.c / 0.18, 1)) * (0.4 + 0.6 * proximity)
		const radians = (color.h * Math.PI) / 180
		hue_x += Math.cos(radians) * weight
		hue_y += Math.sin(radians) * weight
		source_chroma += color.c * weight
		total_weight += weight
		selected_chromas.push(color.c)
	}

	const hue =
		total_weight > 0
			? normalize_hue((Math.atan2(hue_y, hue_x) * 180) / Math.PI)
			: global_hue
	const mean_chroma =
		total_weight > 0
			? source_chroma / total_weight
			: Math.hypot(global.a, global.b) / pixels.length
	const sampled_chroma = Math.max(
		mean_chroma,
		percentile(selected_chromas, 0.9),
	)
	const chromatic_coverage = selected_chromas.length / pixels.length
	const is_neutral = sampled_chroma < 0.04 || chromatic_coverage < 0.005
	const palette_hue = is_neutral ? 0 : hue
	const accent_chroma = is_neutral ? 0 : clamp(sampled_chroma * 1.2, 0.06, 0.17)

	return {
		dark: build_theme(palette_hue, accent_chroma, true),
		light: build_theme(palette_hue, accent_chroma, false),
	}
}
