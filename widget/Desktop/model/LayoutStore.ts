// Loads, checks, updates, and saves monitor files and desktop icon positions.

import { readFile } from "ags/file"

import GLib from "gi://GLib"

import env from "$lib/env"
import { attempt } from "$lib/result"
import { debounce } from "$lib/timing"

const cacheFile = `${env.paths.cache.base}/desktop-layout.json`

type StoredGrid = {
	rows: number
	columns: number
	cellWidth: number
	cellHeight: number
}

type StoredMonitorLayout = {
	positions: Record<string, number>
	grid: StoredGrid | null
}

type StoredLayout = {
	version: 1
	entries: Record<string, string>
	monitors: Record<string, StoredMonitorLayout>
}

type PathEntry = { path: string }

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalizeMonitorId(monitorId: string): string {
	const normalized = monitorId.trim().toLowerCase()
	return normalized.length > 0 ? normalized : "monitor:default"
}

function sanitizePositions(value: unknown): Record<string, number> {
	if (!isRecord(value))
		return {}
	const positions: Record<string, number> = {}
	for (const [path, slot] of Object.entries(value)) {
		if (!path || typeof slot !== "number" || !Number.isFinite(slot))
			continue
		positions[path] = Math.max(0, Math.floor(slot))
	}
	return positions
}

function positionsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
	const aKeys = Object.keys(a)
	const bKeys = Object.keys(b)
	return aKeys.length === bKeys.length && aKeys.every(key => a[key] === b[key])
}

function sanitizeGrid(value: unknown): StoredGrid | null {
	if (!isRecord(value))
		return null
	const rows = typeof value.rows === "number" ? Math.max(1, Math.floor(value.rows)) : 0
	const columns = typeof value.columns === "number" ? Math.max(1, Math.floor(value.columns)) : 0
	const cellWidth = typeof value.cellWidth === "number" ? Math.max(1, Math.floor(value.cellWidth)) : 0
	const cellHeight = typeof value.cellHeight === "number" ? Math.max(1, Math.floor(value.cellHeight)) : 0
	if (!rows || !columns || !cellWidth || !cellHeight)
		return null
	return { rows, columns, cellWidth, cellHeight }
}

function gridsEqual(a: StoredGrid | null, b: StoredGrid | null): boolean {
	if (a === b)
		return true
	if (!a || !b)
		return false
	return a.rows === b.rows
		&& a.columns === b.columns
		&& a.cellWidth === b.cellWidth
		&& a.cellHeight === b.cellHeight
}

function decodeStoredEntries(value: unknown): Record<string, string> {
	if (!isRecord(value))
		return {}

	const entries: Record<string, string> = {}
	for (const [path, rawEntry] of Object.entries(value)) {
		if (path && typeof rawEntry === "string" && rawEntry)
			entries[path] = normalizeMonitorId(rawEntry)
	}
	return entries
}

function decodeStoredMonitors(value: unknown): Record<string, StoredMonitorLayout> {
	if (!isRecord(value))
		return {}

	const monitors: Record<string, StoredMonitorLayout> = {}
	for (const [monitorId, rawMonitor] of Object.entries(value)) {
		if (!isRecord(rawMonitor))
			continue
		monitors[normalizeMonitorId(monitorId)] = {
			positions: sanitizePositions(rawMonitor.positions),
			grid: sanitizeGrid(rawMonitor.grid),
		}
	}
	return monitors
}

function decodeStoredLayout(value: unknown): StoredLayout {
	if (!isRecord(value))
		return { version: 1, entries: {}, monitors: {} }

	return {
		version: 1,
		entries: decodeStoredEntries(value.entries),
		monitors: decodeStoredMonitors(value.monitors),
	}
}

export class DesktopLayoutStore {
	#layout: StoredLayout
	#save = debounce(500, () => this.#write())

	#write(): void {
		const result = attempt(() => GLib.file_set_contents(cacheFile, JSON.stringify(this.#layout, null, 2)))
		if (!result.ok)
			console.error("desktop.save: Failed to save desktop layout", result.err)
	}

	constructor() {
		if (!GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) {
			this.#layout = decodeStoredLayout({})
			return
		}
		const result = attempt((): unknown => JSON.parse(readFile(cacheFile) || "{}"))
		if (!result.ok)
			console.error("desktop.loadLayout: Failed to load desktop layout", result.err)
		this.#layout = decodeStoredLayout(result.ok ? result.value : {})
	}

	dispose(): void {
		if (this.#save.pending)
			this.#save.flush()
		this.#save.cancel()
	}

	normalizeMonitorId(monitorId: string): string {
		return normalizeMonitorId(monitorId)
	}

	monitorIds(): string[] {
		return Object.keys(this.#layout.monitors)
	}

	fallbackMonitor(): string {
		return this.monitorIds()[0] ?? "monitor:default"
	}

	monitorOf(path: string): string | null {
		return path ? this.#layout.entries[path] ?? null : null
	}

	ensureMonitor(monitorId: string): string {
		const key = normalizeMonitorId(monitorId)
		if (!this.#layout.monitors[key])
			this.#layout.monitors[key] = { positions: {}, grid: null }
		return key
	}

	gridOf(monitorId: string): StoredGrid | null {
		const grid = this.#layout.monitors[normalizeMonitorId(monitorId)]?.grid
		return grid ? { ...grid } : null
	}

	setGrid(monitorId: string, grid?: StoredGrid): boolean {
		if (!grid)
			return false

		const key = this.ensureMonitor(monitorId)
		const next = { rows: grid.rows, columns: grid.columns, cellWidth: grid.cellWidth, cellHeight: grid.cellHeight }
		if (gridsEqual(this.#layout.monitors[key].grid, next))
			return false

		this.#layout.monitors[key].grid = next
		this.#save.call()
		return true
	}

	positionsOf(monitorId: string): Record<string, number> {
		return { ...(this.#layout.monitors[normalizeMonitorId(monitorId)]?.positions ?? {}) }
	}

	setPositions(monitorId: string, positions: Record<string, number>): boolean {
		const key = this.ensureMonitor(monitorId)
		const next = sanitizePositions(positions)
		if (positionsEqual(this.#layout.monitors[key].positions, next))
			return false

		this.#layout.monitors[key].positions = next
		this.#save.call()
		return true
	}

	filesOnMonitor<T extends PathEntry>(files: T[], monitorId: string): T[] {
		const key = normalizeMonitorId(monitorId)
		return files.filter(file => this.#layout.entries[file.path] === key)
	}

	homeSlotOf(path: string): number | null {
		if (!path)
			return null
		const monitorId = this.#layout.entries[path]
		if (!monitorId)
			return null
		const slot = this.#layout.monitors[monitorId]?.positions[path]
		if (typeof slot !== "number" || !Number.isFinite(slot))
			return null
		return Math.max(0, Math.floor(slot))
	}

	assignPaths(paths: string[], monitorId: string): boolean {
		const target = this.ensureMonitor(monitorId)
		let changed = false

		for (const path of new Set(paths)) {
			if (!path)
				continue

			if (this.#layout.entries[path] !== target) {
				this.#layout.entries[path] = target
				changed = true
			}

			for (const [id, monitor] of Object.entries(this.#layout.monitors)) {
				if (id === target)
					continue
				if (path in monitor.positions) {
					delete monitor.positions[path]
					changed = true
				}
			}
		}

		if (changed)
			this.#save.call()
		return changed
	}

	renamePath(oldPath: string, newPath: string): void {
		if (!oldPath || !newPath || oldPath === newPath)
			return

		const oldEntry = this.#layout.entries[oldPath]
		if (oldEntry) {
			this.#layout.entries[newPath] = oldEntry
			delete this.#layout.entries[oldPath]
		}

		for (const monitor of Object.values(this.#layout.monitors)) {
			if (!(oldPath in monitor.positions))
				continue
			monitor.positions[newPath] = monitor.positions[oldPath]
			delete monitor.positions[oldPath]
		}

		this.#save.call()
	}

	syncPaths(files: PathEntry[], fallbackMonitorId: string): boolean {
		const fallback = this.ensureMonitor(fallbackMonitorId)
		const validPaths = new Set(files.map(file => file.path))
		let changed = false

		for (const path of Object.keys(this.#layout.entries)) {
			if (!validPaths.has(path)) {
				delete this.#layout.entries[path]
				changed = true
			}
		}

		for (const monitor of Object.values(this.#layout.monitors)) {
			for (const path of Object.keys(monitor.positions)) {
				if (!validPaths.has(path)) {
					delete monitor.positions[path]
					changed = true
				}
			}
		}

		for (const file of files) {
			let monitor = this.#layout.entries[file.path]
			if (!monitor) {
				this.#layout.entries[file.path] = fallback
				changed = true
				continue
			}

			if (monitor === "monitor:default" && fallback !== "monitor:default")
				monitor = fallback

			const key = this.ensureMonitor(monitor)
			if (this.#layout.entries[file.path] !== key) {
				this.#layout.entries[file.path] = key
				changed = true
			}
		}

		if (changed)
			this.#save.call()
		return changed
	}
}
