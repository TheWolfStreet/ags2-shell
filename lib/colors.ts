export type rgb = {
	r: number
	g: number
	b: number
}

export type theme_colors = {
	bg: string
	fg: string
	widget: string
	border: string
	primary_bg: string
	primary_fg: string
	error_bg: string
}

export type wallpaper_palette = {
	dark: theme_colors
	light: theme_colors
}

type oklab = {
	l: number
	a: number
	b: number
}

type oklch = {
	l: number
	c: number
	h: number
}

const hue_bin_count = 24
const min_chroma = 0.025
const smoothing_weights = [
	[-2, 0.35],
	[-1, 0.7],
	[0, 1],
	[1, 0.7],
	[2, 0.35],
]

function clamp(value: number, min = 0, max = 1) {
	return Math.min(max, Math.max(min, value))
}

function normalize_hue(hue: number) {
	return ((hue % 360) + 360) % 360
}

function radians(degrees: number) {
	return (degrees * Math.PI) / 180
}

function hue_of(a: number, b: number) {
	return normalize_hue((Math.atan2(b, a) * 180) / Math.PI)
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

function rgb_to_oklab({ r, g, b }: rgb): oklab {
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

function oklab_to_oklch({ l, a, b }: oklab): oklch {
	return {
		l,
		c: Math.hypot(a, b),
		h: hue_of(a, b),
	}
}

function linear_rgb_from_oklch({ l, c, h }: oklch): rgb {
	const angle = radians(h)
	const a = c * Math.cos(angle)
	const b = c * Math.sin(angle)
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

function in_gamut({ r, g, b }: rgb) {
	return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1
}

function oklch_to_rgb(color: oklch): rgb {
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

function to_hex({ r, g, b }: rgb) {
	const channel = (value: number) =>
		Math.round(clamp(value) * 255)
			.toString(16)
			.padStart(2, "0")
	return `#${channel(r)}${channel(g)}${channel(b)}`
}

function relative_luminance({ r, g, b }: rgb) {
	return (
		0.2126 * srgb_to_linear(r) +
		0.7152 * srgb_to_linear(g) +
		0.0722 * srgb_to_linear(b)
	)
}

function contrast_ratio(a: rgb, b: rgb) {
	const lighter = Math.max(relative_luminance(a), relative_luminance(b))
	const darker = Math.min(relative_luminance(a), relative_luminance(b))
	return (lighter + 0.05) / (darker + 0.05)
}

function color_at(l: number, c: number, h: number) {
	return oklch_to_rgb({ l, c, h })
}

function black_or_white(background: rgb) {
	const black = { r: 0, g: 0, b: 0 }
	const white = { r: 1, g: 1, b: 1 }
	if (contrast_ratio(background, black) >= contrast_ratio(background, white))
		return black
	return white
}

function readable_text(background: rgb, hue: number, tinted: boolean) {
	if (!tinted) return black_or_white(background)
	const dark = color_at(0.15, 0.012, hue)
	const light = color_at(0.97, 0.008, hue)
	const dark_contrast = contrast_ratio(background, dark)
	const light_contrast = contrast_ratio(background, light)
	if (Math.max(dark_contrast, light_contrast) < 4.5)
		return black_or_white(background)
	return dark_contrast >= light_contrast ? dark : light
}

function primary_lightness(accent_chroma: number, dark: boolean) {
	if (accent_chroma === 0) return dark ? 0.88 : 0.28
	return dark ? 0.74 : 0.59
}

function build_theme(
	hue: number,
	accent_chroma: number,
	dark: boolean,
): theme_colors {
	const surface_chroma = Math.min(0.018, accent_chroma * 0.15)
	const border_chroma = Math.min(0.035, accent_chroma * 0.28)
	const bg = color_at(dark ? 0.15 : 0.98, surface_chroma, hue)
	const fg = color_at(dark ? 0.93 : 0.2, Math.min(0.015, surface_chroma), hue)
	const border = color_at(dark ? 0.58 : 0.48, border_chroma, hue)
	const primary_bg = color_at(
		primary_lightness(accent_chroma, dark),
		accent_chroma,
		hue,
	)
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

function dominant_hue(labs: oklch[]) {
	const bin_scores = Array.from({ length: hue_bin_count }, () => 0)
	const bin_size = 360 / hue_bin_count

	for (const color of labs) {
		if (color.c < min_chroma || color.l < 0.08 || color.l > 0.96) continue
		const bin = Math.floor(color.h / bin_size) % hue_bin_count
		const chroma_weight = 0.65 + 0.35 * Math.min(color.c / 0.18, 1)
		const tone_weight =
			0.75 + 0.25 * (1 - Math.min(Math.abs(color.l - 0.6) / 0.6, 1))
		bin_scores[bin] += chroma_weight * tone_weight
	}

	const smoothed = bin_scores.map((_score, bin) => {
		let score = 0
		for (const [offset, weight] of smoothing_weights) {
			const neighbor = (bin + offset + hue_bin_count) % hue_bin_count
			score += bin_scores[neighbor] * weight
		}
		return score
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

function chroma_vector(labs: oklch[]) {
	return labs.reduce(
		(sum, color) => ({
			a: sum.a + color.c * Math.cos(radians(color.h)),
			b: sum.b + color.c * Math.sin(radians(color.h)),
		}),
		{ a: 0, b: 0 },
	)
}

function sample_accent(labs: oklch[], target_hue: number) {
	const sample = { x: 0, y: 0, chroma: 0, weight: 0, chromas: [] as number[] }
	for (const color of labs) {
		const distance = hue_distance(color.h, target_hue)
		if (color.c < min_chroma || distance > 42) continue
		const proximity = 1 - distance / 42
		const weight =
			(0.6 + 0.4 * Math.min(color.c / 0.18, 1)) * (0.4 + 0.6 * proximity)
		const angle = radians(color.h)
		sample.x += Math.cos(angle) * weight
		sample.y += Math.sin(angle) * weight
		sample.chroma += color.c * weight
		sample.weight += weight
		sample.chromas.push(color.c)
	}
	return sample
}

export function build_wallpaper_palette(
	pixels: readonly rgb[],
): wallpaper_palette | null {
	if (pixels.length === 0) return null

	const labs = pixels.map(rgb_to_oklab).map(oklab_to_oklch)
	const global = chroma_vector(labs)
	const global_hue = hue_of(global.a, global.b)
	const sample = sample_accent(labs, dominant_hue(labs) ?? global_hue)
	const sampled = sample.weight > 0
	const hue = sampled ? hue_of(sample.x, sample.y) : global_hue
	const mean_chroma = sampled
		? sample.chroma / sample.weight
		: Math.hypot(global.a, global.b) / pixels.length
	const sampled_chroma = Math.max(mean_chroma, percentile(sample.chromas, 0.9))
	const coverage = sample.chromas.length / pixels.length
	const is_neutral = sampled_chroma < 0.04 || coverage < 0.005
	const palette_hue = is_neutral ? 0 : hue
	const accent_chroma = is_neutral ? 0 : clamp(sampled_chroma * 1.2, 0.06, 0.17)

	return {
		dark: build_theme(palette_hue, accent_chroma, true),
		light: build_theme(palette_hue, accent_chroma, false),
	}
}
