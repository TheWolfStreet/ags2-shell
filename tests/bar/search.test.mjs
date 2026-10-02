import { test } from "node:test"
import assert from "node:assert/strict"
import { rank_apps, display_apps } from "../../widget/Bar/components/Launcher/search.ts"

test("query changes reorder existing results and preserve distinct desktop entries", () => {
	const index = [
		{ app: { id: "native.desktop" }, name: "ab" },
		{ app: { id: "flatpak.desktop" }, name: "ba" },
		{ app: { id: "second-native.desktop" }, name: "ab" },
	]
	assert.deepEqual(rank_apps(index, "a", 9).map((app) => app.id), [
		"native.desktop", "second-native.desktop", "flatpak.desktop",
	])
	assert.deepEqual(rank_apps(index, "b", 9).map((app) => app.id), [
		"flatpak.desktop", "native.desktop", "second-native.desktop",
	])
})

test("bottom display numbering matches shortcut order", () => {
	const results = rank_apps([
		{ app: "ab", name: "ab" },
		{ app: "ba", name: "ba" },
	], "a", 9)
	assert.deepEqual(display_apps(results, false), [
		{ app: "ab", rank: 0 }, { app: "ba", rank: 1 },
	])
	assert.deepEqual(display_apps(results, true), [
		{ app: "ba", rank: 0 }, { app: "ab", rank: 1 },
	])
})

test("zero preserves the legacy nine-result fallback and explicit counts are honored", () => {
	const index = [
		{ app: "one", name: "app one" },
		{ app: "two", name: "app two" },
	]
	assert.deepEqual(rank_apps(index, "app", 0), ["one", "two"])
	assert.deepEqual(rank_apps(index, "app", 1), ["one"])
	assert.deepEqual(rank_apps(index, "  ", 9), [])
	const catalog = Array.from({ length: 20 }, (_, index) => ({ app: index, name: `app ${String(index).padStart(2, "0")}` }))
	assert.equal(rank_apps(catalog, "app", 0).length, 9)
	assert.equal(rank_apps(catalog, "app", 15).length, 15)
	assert.equal(rank_apps(catalog, "app", 100).length, catalog.length)
	assert.deepEqual(rank_apps(catalog, "app", -1), [])
	assert.deepEqual(rank_apps(catalog, "app", Number.POSITIVE_INFINITY), [])
})
