// Caches command availability checks.

import GLib from "gi://GLib"

const dependencyCache = new Map<string, boolean>()

export function hasProgram(name: string) {
	let found = dependencyCache.get(name)
	if (found === undefined) {
		found = GLib.find_program_in_path(name) !== null
		dependencyCache.set(name, found)
	}
	return found
}
