export function rank_apps<T>(index: Array<{ app: T; name: string }>, query: string, limit: number): T[] {
	const normalized = query.trim().toLowerCase()
	if (!normalized || limit <= 0) return []
	return index
		.map((item) => ({ ...item, match: item.name.indexOf(normalized) }))
		.filter((item) => item.match >= 0)
		.sort((left, right) => left.match - right.match || left.name.localeCompare(right.name))
		.slice(0, Math.min(9, limit))
		.map((item) => item.app)
}

export function display_apps<T>(apps: T[], bottom: boolean) {
	const ordered = bottom ? [...apps].reverse() : apps
	return ordered.map((app, rank) => ({ app, rank }))
}
