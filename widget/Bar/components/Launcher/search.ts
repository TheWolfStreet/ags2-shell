// Finds and ranks applications by name and description without matching letter case.

import AstalApps from "gi://AstalApps"

export type IndexedApplication = {
	app: AstalApps.Application
	name: string
}

export function indexApplications(applications: AstalApps.Application[]): IndexedApplication[] {
	return applications.map(app => ({ app, name: app.get_name().toLowerCase() }))
}

export function rankApplications(index: IndexedApplication[], query: string, limit: number) {
	const normalizedQuery = query.trim().toLowerCase()
	if (!normalizedQuery) return []

	return index
		.map(indexed => ({ ...indexed, matchPosition: indexed.name.indexOf(normalizedQuery) }))
		.filter(result => result.matchPosition >= 0)
		.sort((left, right) => {
			if (left.matchPosition !== right.matchPosition)
				return left.matchPosition - right.matchPosition
			return left.name.localeCompare(right.name)
		})
		.slice(0, limit)
		.map(result => result.app)
}
