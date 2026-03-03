import { Accessor, createComputed, createState } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import GObject, { register } from "ags/gobject"

import Gio from "gi://Gio"

import env from "$lib/env"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/timing"

import {
	clearClipboardFiles,
	getClipboardFiles,
	setClipboardFiles,
} from "./clipboard"
import {
	createDesktopFolder,
	getDesktopPath,
	importDesktopFiles,
	loadDesktopFiles,
	openFile,
	pasteFiles,
	permanentlyDeleteFiles,
	renameFile,
	trashFiles,
} from "./files"
import type { DesktopFile } from "./files"
import {
	equalGrid,
	isRecord,
	movePathsToGrid,
	movePathsToSlot,
	normalizePositions,
	normalizeMonitorId,
	pickPositions,
	positionsEqual,
	remapSlotsAcrossColumns,
	StoredGrid,
	StoredLayout,
	StoredMonitorLayout,
	sanitizeGrid,
	sanitizePositions,
} from "./layout"
import type { GridMetrics } from "./layout"
import type { ClipboardPayload } from "./clipboard"

const cacheFile = `${env.paths.cache.base}/desktop-layout.json`

export type Grid = {
	files: Accessor<DesktopFile[]>
	positions: Accessor<Record<string, number>>
	resize(metrics: GridMetrics): void
	move(move: { paths: string[], slot: number, anchor?: string }): void
	import(paths: string[], operation: "copy" | "move"): Promise<void>
	paste(): Promise<void>
	createFolder(): string | null
}

type Visible = { files: DesktopFile[], positions: Record<string, number> }

@register()
export default class DesktopService extends GObject.Object {
	declare static $gtype: GObject.GType<DesktopService>
	static instance: DesktopService

	static get_default() {
		return this.instance ??= new DesktopService()
	}

	#store: StoredLayout
	#save = debounce(500, async () => {
		const result = await attemptAsync(async () => {
			await writeFileAsync(cacheFile, JSON.stringify(this.#store, null, 2))
		})
		if (!result.ok)
			console.error("desktop.save: Failed to save desktop layout", result.err)
	})
	#refresh = debounce(120, () => this.#reload())

	#files: Accessor<DesktopFile[]>
	#setFiles: (v: DesktopFile[]) => void
	#sizes: Accessor<Record<string, GridMetrics>>
	#setSizes: (v: Record<string, GridMetrics>) => void
	#connected: Accessor<Set<string>>
	#setConnected: (v: Set<string>) => void
	#primary: Accessor<string>
	#setPrimary: (v: string) => void
	#rev: Accessor<number>
	#setRev: (v: number) => void

	#clipboardState: Accessor<ClipboardPayload | null>
	#setClipboardState: (v: ClipboardPayload | null) => void

	#grids: Map<string, Grid>
	#monitor: Gio.FileMonitor | null

	constructor() {
		super()

		this.#grids = new Map()
		this.#monitor = null
		this.#store = this.#load()

		const [files, setFiles] = createState<DesktopFile[]>([])
		const [sizes, setSizes] = createState<Record<string, GridMetrics>>({})
		const [connected, setConnected] = createState<Set<string>>(new Set())
		const [primary, setPrimary] = createState("")
		const [rev, setRev] = createState(0)
		const [clip, setClip] = createState<ClipboardPayload | null>(null)

		this.#files = files
		this.#setFiles = setFiles
		this.#sizes = sizes
		this.#setSizes = setSizes
		this.#connected = connected
		this.#setConnected = setConnected
		this.#primary = primary
		this.#setPrimary = setPrimary
		this.#rev = rev
		this.#setRev = setRev
		this.#clipboardState = clip
		this.#setClipboardState = setClip

		this.#reload()
		this.#watch()
	}

	get clipboard(): Accessor<ClipboardPayload | null> {
		return this.#clipboardState
	}

	#load(): StoredLayout {
		const result = attempt((): unknown => JSON.parse(readFile(cacheFile) || "{}"))
		if (!result.ok)
			console.error("desktop.loadLayout: Failed to load desktop layout", result.err)
		const parsed: unknown = result.ok ? result.value : {}

		if (!isRecord(parsed))
			return { version: 1, entries: {}, monitors: {} }

		const entries: Record<string, string> = {}
		const monitors: Record<string, StoredMonitorLayout> = {}

		const rawEntries = parsed.entries
		if (isRecord(rawEntries)) {
			for (const [path, value] of Object.entries(rawEntries)) {
				const monitor = typeof value === "string" ? value
					: isRecord(value) && typeof value.monitor === "string" ? value.monitor
						: null
				if (!path || !monitor)
					continue
				entries[path] = normalizeMonitorId(monitor)
			}
		}

		const rawMonitors = parsed.monitors
		if (isRecord(rawMonitors)) {
			for (const [monitorId, value] of Object.entries(rawMonitors)) {
				if (!isRecord(value))
					continue
				monitors[normalizeMonitorId(monitorId)] = {
					positions: sanitizePositions(value.positions),
					grid: sanitizeGrid(value.grid),
				}
			}
		}

		return { version: 1, entries, monitors }
	}

	#reload(preferredMonitorId?: string) {
		const files = loadDesktopFiles()
		if (files instanceof Error) {
			console.error("desktop.loadDesktopFiles: Failed to load desktop files", files)
			return
		}

		this.#syncEntries(files, preferredMonitorId?.trim() || this.#primary() || this.fallbackMonitor())
		this.#normalizeKnownPositions(files)
		this.#setFiles(files)
		this.#bumpRevision()
	}

	#watch() {
		if (this.#monitor)
			return
		const result = attempt(() => {
			const dir = Gio.File.new_for_path(getDesktopPath())
			this.#monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
			this.#monitor.connect("changed", () => this.#refresh.call())
		})
		if (!result.ok)
			console.error("desktop.watchDesktopDir: Failed to watch desktop directory", result.err)
	}

	#bumpRevision() {
		this.#setRev(this.#rev() + 1)
	}

	grid(monitorId: string): Grid {
		const id = normalizeMonitorId(monitorId)
		const cached = this.#grids.get(id)
		if (cached)
			return cached

		const visible = createComputed((): Visible => {
			return this.#computeVisible(id)
		})

		const grid: Grid = {
			files: createComputed(() => visible().files),
			positions: createComputed(() => visible().positions),
			resize: (metrics) => this.#resize(id, metrics),
			move: move => this.#move(id, move.paths, move.slot, move.anchor),
			import: (paths, operation) => this.#import(paths, id, operation),
			paste: () => this.#paste(id),
			createFolder: () => this.#createFolder(id),
		}

		this.#grids.set(id, grid)
		return grid
	}

	#resize(id: string, metrics: GridMetrics) {
		const key = this.#ensureMonitor(id)
		const prevGrid = this.#gridOf(key)
		let positionsChanged = false

		if (prevGrid && prevGrid.columns !== metrics.columns) {
			const slotCount = metrics.rows * metrics.columns
			const remapped = remapSlotsAcrossColumns(this.#store.monitors[key].positions, prevGrid.columns, metrics.columns, slotCount)
			positionsChanged = this.#setStoredPositions(key, remapped)
		}

		this.#storeGrid(key, metrics)
		this.#setSizes({ ...this.#sizes(), [key]: metrics })
		if (this.#normalizeOwnedPositions(key, this.#files(), metrics))
			positionsChanged = true
		if (positionsChanged)
			this.#bumpRevision()
	}

	setMonitors(ids: string[], primaryId: string) {
		this.#setConnected(new Set(ids.map(normalizeMonitorId)))
		this.#setPrimary(normalizeMonitorId(primaryId))
	}

	#computeVisible(id: string): Visible {
		const files = this.#files()
		const metrics = this.#sizes()[id]
		const connected = this.#connected()
		const isPrimary = this.#primary() === id
		this.#rev()

		const owned = this.#filesOnMonitor(files, id)
		if (!metrics)
			return { files: owned, positions: this.#positionsOf(id) }

		const totalSlots = metrics.rows * metrics.columns
		const stored = this.#positionsOf(id)
		const positions = normalizePositions(owned, stored, totalSlots, metrics.columns)

		const usedSlots = new Set(Object.values(positions))
		const visibleFiles = [...owned]
		const visiblePositions: Record<string, number> = { ...positions }

		const projected = isPrimary
			? files.filter((file) => {
				const home = this.monitorOf(file.path)
				return !!home && home !== id && !connected.has(home)
			})
			: []

		const firstFreeSlot = () => {
			for (let slot = 0; slot < totalSlots; slot += 1)
				if (!usedSlots.has(slot)) return slot
			return null
		}

		const byHomeSlot = [...projected].sort((a, b) => {
			const aSlot = this.#homeSlotOf(a.path) ?? Number.MAX_SAFE_INTEGER
			const bSlot = this.#homeSlotOf(b.path) ?? Number.MAX_SAFE_INTEGER
			return aSlot !== bSlot ? aSlot - bSlot : a.name.localeCompare(b.name)
		})

		for (const file of byHomeSlot) {
			const home = this.#homeSlotOf(file.path)
			const homeFree = home != null && home >= 0 && home < totalSlots && !usedSlots.has(home)
			const slot = homeFree ? home : firstFreeSlot()
			if (slot == null)
				continue

			usedSlots.add(slot)
			visibleFiles.push(file)
			visiblePositions[file.path] = slot
		}

		return { files: visibleFiles, positions: visiblePositions }
	}

	#normalizeOwnedPositions(id: string, files: DesktopFile[], metrics: GridMetrics) {
		const owned = this.#filesOnMonitor(files, id)
		const slotCount = metrics.rows * metrics.columns
		const positions = normalizePositions(owned, this.#positionsOf(id), slotCount, metrics.columns)
		return this.#setPositions(id, positions)
	}

	#normalizeKnownPositions(files: DesktopFile[]) {
		for (const [id, metrics] of Object.entries(this.#sizes())) {
			this.#normalizeOwnedPositions(id, files, metrics)
		}
	}

	#move(targetId: string, paths: string[], targetSlot: number, anchor?: string) {
		const uniquePaths = Array.from(new Set(paths)).filter(Boolean)
		if (uniquePaths.length === 0)
			return

		const metrics = this.#sizes()[targetId]
		if (!metrics)
			return

		const anchorPath = anchor ?? uniquePaths[0]
		const sourceMonitor = this.monitorOf(anchorPath) ?? this.monitorOf(uniquePaths[0]) ?? targetId

		const slotCount = metrics.rows * metrics.columns
		const columns = metrics.columns
		const target = this.#computeVisible(targetId)

		if (normalizeMonitorId(sourceMonitor) === targetId) {
			this.#assignToMonitor(uniquePaths, targetId)
			const nextPositions = movePathsToSlot(
				{ positions: target.positions, columns, slotCount },
				target.files,
				{ paths: uniquePaths, anchorPath, targetSlot },
			)
			const ownedPaths = new Set(this.#filesOnMonitor(this.#files(), targetId).map(file => file.path))
			this.#setPositions(targetId, pickPositions(ownedPaths, nextPositions))
			this.#bumpRevision()
			return
		}

		const sourcePositions = this.#positionsOf(sourceMonitor)
		const sourceCols = this.#gridOf(sourceMonitor)?.columns ?? columns
		const targetPositions = { ...target.positions }
		for (const path of uniquePaths)
			delete targetPositions[path]

		const nextTarget = movePathsToGrid(
			{ positions: sourcePositions, columns: sourceCols },
			{ positions: targetPositions, columns, slotCount },
			{ paths: uniquePaths, anchorPath, targetSlot },
		)

		this.#assignToMonitor(uniquePaths, targetId)

		const targetPaths = new Set(this.#filesOnMonitor(this.#files(), targetId).map(file => file.path))
		this.#setPositions(targetId, pickPositions(targetPaths, nextTarget))

		this.#bumpRevision()
	}

	open(paths: string[]) {
		for (const path of paths) {
			const error = openFile(path)
			if (error instanceof Error)
				console.error("desktop.open: Failed to open desktop file", error)
		}
	}

	copy(paths: string[]) {
		this.#setClipboard("copy", paths)
	}

	cut(paths: string[]) {
		this.#setClipboard("cut", paths)
	}

	#setClipboard(operation: "copy" | "cut", paths: string[]) {
		const files = Array.from(new Set(paths)).filter(Boolean)
		if (files.length === 0)
			return

		void setClipboardFiles(operation, files).then(error => {
			if (error instanceof Error)
				console.error("desktop.setClipboardFiles: Failed to set desktop clipboard", error)
		})
		this.#setClipboardState({ operation, files })
	}

	async cancelCut() {
		const current = await getClipboardFiles()
		if (current && current.operation === "cut") {
			const error = await clearClipboardFiles()
			if (error instanceof Error)
				console.error("desktop.clearClipboardFiles: Failed to clear desktop clipboard", error)
		}
		if (this.#clipboardState()?.operation === "cut")
			this.#setClipboardState(null)
	}

	async #paste(monitorId: string) {
		const current = await getClipboardFiles()
		const data = current || this.#clipboardState()
		if (!data || data.files.length === 0)
			return

		const monitor = monitorId.trim() || this.fallbackMonitor()
		const error = await pasteFiles(data.files, data.operation, () => this.#reload(monitor))
		if (error instanceof Error) {
			console.error("desktop.pasteFiles: Failed to paste desktop files", error)
			return
		}

		if (data.operation === "cut")
			this.#setClipboardState(null)
	}

	remove(paths: string[], opts: { permanently?: boolean } = {}) {
		if (paths.length === 0)
			return

		let error: void | Error
		if (opts.permanently) {
			error = permanentlyDeleteFiles(paths, () => this.#reload())
		} else {
			error = trashFiles(paths, () => this.#reload())
		}
		if (error instanceof Error)
			console.error("desktop.remove: Failed to remove desktop files", error)
	}

	async #import(paths: string[], monitor: string, operation: "copy" | "move") {
		const error = await importDesktopFiles(paths, operation, () => this.#reload(monitor))
		if (error instanceof Error)
			console.error("desktop.importFiles: Failed to import files", error)
	}

	#createFolder(monitorId: string) {
		const path = createDesktopFolder()
		if (path instanceof Error) {
			console.error("desktop.createFolder: Failed to create desktop folder", path)
			return null
		}

		this.#assignToMonitor([path], monitorId)
		this.#reload(monitorId)
		return path
	}

	rename(target: string, name: string): string | null {
		if (!target || !name.trim())
			return null

		const path = renameFile(target, name, () => this.#reload())
		if (path instanceof Error) {
			console.error("desktop.rename: Failed to rename desktop file", path)
			return null
		}

		this.#renameEntry(target, path)
		this.#setFiles(this.#files().map(file => file.path === target
			? { ...file, path, name: path.split("/").pop() ?? file.name }
			: file))
		this.#bumpRevision()
		return path
	}

	monitorOf(path: string) {
		if (!path)
			return null
		return this.#store.entries[path] ?? null
	}

	monitorIds() {
		return Object.keys(this.#store.monitors)
	}

	fallbackMonitor() {
		return this.monitorIds()[0] ?? "monitor:default"
	}

	#ensureMonitor(monitorId: string) {
		const key = normalizeMonitorId(monitorId)
		if (!this.#store.monitors[key])
			this.#store.monitors[key] = { positions: {}, grid: null }
		return key
	}

	#storeGrid(monitorId: string, grid?: GridMetrics) {
		if (!grid)
			return false

		const key = this.#ensureMonitor(monitorId)
		const next: StoredGrid = { rows: grid.rows, columns: grid.columns, cellWidth: grid.cellWidth, cellHeight: grid.cellHeight }
		if (equalGrid(this.#store.monitors[key].grid, next))
			return false

		this.#store.monitors[key].grid = next
		this.#save.call()
		return true
	}

	#filesOnMonitor(files: DesktopFile[], monitorId: string) {
		const key = normalizeMonitorId(monitorId)
		return files.filter(file => this.#store.entries[file.path] === key)
	}

	#homeSlotOf(path: string) {
		if (!path)
			return null
		const monitorId = this.#store.entries[path]
		if (!monitorId)
			return null
		const slot = this.#store.monitors[monitorId]?.positions[path]
		if (typeof slot !== "number" || !Number.isFinite(slot))
			return null
		return Math.max(0, Math.floor(slot))
	}

	#gridOf(monitorId: string) {
		const grid = this.#store.monitors[normalizeMonitorId(monitorId)]?.grid
		return grid ? { ...grid } : null
	}

	#positionsOf(monitorId: string) {
		return { ...(this.#store.monitors[normalizeMonitorId(monitorId)]?.positions ?? {}) }
	}

	#setStoredPositions(key: string, positions: Record<string, number>) {
		const monitor = this.#store.monitors[key]
		if (positionsEqual(monitor.positions, positions))
			return false
		monitor.positions = positions
		this.#save.call()
		return true
	}

	#setPositions(monitorId: string, nextPositions: Record<string, number>) {
		const key = this.#ensureMonitor(monitorId)
		return this.#setStoredPositions(key, sanitizePositions(nextPositions))
	}

	#assignToMonitor(paths: string[], monitorId: string) {
		const target = this.#ensureMonitor(monitorId)
		let changed = false

		for (const path of new Set(paths)) {
			if (!path)
				continue

			if (this.#store.entries[path] !== target) {
				this.#store.entries[path] = target
				changed = true
			}

			for (const [id, monitor] of Object.entries(this.#store.monitors)) {
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

	#renameEntry(oldPath: string, newPath: string) {
		if (!oldPath || !newPath || oldPath === newPath)
			return

		const oldEntry = this.#store.entries[oldPath]
		if (oldEntry) {
			this.#store.entries[newPath] = oldEntry
			delete this.#store.entries[oldPath]
		}

		for (const monitor of Object.values(this.#store.monitors)) {
			if (!(oldPath in monitor.positions))
				continue
			monitor.positions[newPath] = monitor.positions[oldPath]
			delete monitor.positions[oldPath]
		}

		this.#save.call()
	}

	#syncEntries(files: DesktopFile[], fallbackMonitorId: string) {
		const fallback = this.#ensureMonitor(fallbackMonitorId)
		const validPaths = new Set(files.map(file => file.path))
		let changed = false

		for (const path of Object.keys(this.#store.entries)) {
			if (!validPaths.has(path)) {
				delete this.#store.entries[path]
				changed = true
			}
		}

		for (const monitor of Object.values(this.#store.monitors)) {
			for (const path of Object.keys(monitor.positions)) {
				if (!validPaths.has(path)) {
					delete monitor.positions[path]
					changed = true
				}
			}
		}

		for (const file of files) {
			let monitor = this.#store.entries[file.path]
			if (!monitor) {
				this.#store.entries[file.path] = fallback
				changed = true
				continue
			}

			if (monitor === "monitor:default" && fallback !== "monitor:default")
				monitor = fallback

			const key = this.#ensureMonitor(monitor)
			if (this.#store.entries[file.path] !== key) {
				this.#store.entries[file.path] = key
				changed = true
			}
		}

		if (changed)
			this.#save.call()
		return changed
	}
}
