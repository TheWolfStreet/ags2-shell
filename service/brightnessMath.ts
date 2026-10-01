export function parse_ddc_brightness(raw: string): { current: number, maximum: number } | null {
	const match = raw.match(/^VCP\s+10\s+C\s+(\d+)\s+(\d+)\s*$/im)
	if (!match) return null
	const current = Number(match[1])
	const maximum = Number(match[2])
	return Number.isSafeInteger(current) && Number.isSafeInteger(maximum) &&
		maximum > 0 && current >= 0 && current <= maximum ? { current, maximum } : null
}

export function brightness_target(percent: number, maximum = 100): number {
	const bounded = Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0
	return Math.round(bounded * maximum)
}
