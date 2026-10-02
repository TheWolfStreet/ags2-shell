export function rank_apps<T>(index: Array<{ app: T; name: string }>, query: string, limit: number): T[] {
	const normalized = query.trim().toLowerCase()
	if (!normalized || !Number.isFinite(limit) || limit < 0) return []
	const count = limit === 0 ? 9 : Math.floor(limit)
	return index
		.map((item) => ({ ...item, match: item.name.indexOf(normalized) }))
		.filter((item) => item.match >= 0)
		.sort((left, right) => left.match - right.match || left.name.localeCompare(right.name))
		.slice(0, count)
		.map((item) => item.app)
}

export function display_apps<T>(apps: T[], bottom: boolean) {
	const ordered = bottom ? [...apps].reverse() : apps
	return ordered.map((app, rank) => ({ app, rank }))
}
