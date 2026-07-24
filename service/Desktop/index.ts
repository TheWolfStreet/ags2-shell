// Lists desktop files and handles monitor layouts, icon placement, selection, and file changes.

import { Accessor, createComputed, createState } from "ags"
import GObject, { register } from "ags/gobject"

import Gio from "gi://Gio"

import { attempt } from "$lib/result"
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
	movePathsToGrid,
	movePathsToSlot,
	normalizePositions,
	pickPositions,
	remapSlotsAcrossColumns,
} from "./placement"
import { DesktopLayoutStore } from "./storage"
import type { GridMetrics } from "./geometry"
import type { ClipboardPayload } from "./clipboard"

type Grid = {
	files: Accessor<DesktopFile[]>
	positions: Accessor<Record<string, number>>
	resize(metrics: GridMetrics): void
	move(move: { paths: string[], slot: number, anchor?: string }): void
	import(paths: string[], operation: "copy" | "move"): Promise<void>
	paste(): Promise<void>
	createFolder(): string | null
}

type ProjectedGridView = { files: DesktopFile[], positions: Record<string, number> }

@register()
class DesktopService extends GObject.Object {
	declare static $gtype: GObject.GType<DesktopService>
	static instance: DesktopService

	static get_default() {
		return this.instance ??= new DesktopService()
	}

	#layoutStore: DesktopLayoutStore
	#refresh = debounce(120, () => this.#reload())

	#files: Accessor<DesktopFile[]>
	#setFiles: (next: DesktopFile[]) => void
	#gridMetrics: Accessor<Record<string, GridMetrics>>
	#setGridMetrics: (next: Record<string, GridMetrics>) => void
	#connectedMonitors: Accessor<Set<string>>
	#setConnectedMonitors: (next: Set<string>) => void
	#primaryMonitor: Accessor<string>
	#setPrimaryMonitor: (next: string) => void
	#layoutRevision: Accessor<number>
	#setLayoutRevision: (next: number) => void

	#clipboardState: Accessor<ClipboardPayload | null>
	#setClipboardState: (next: ClipboardPayload | null) => void

	#grids: Map<string, Grid>
	#monitor: Gio.FileMonitor | null

	constructor() {
		super()

		this.#grids = new Map()
		this.#monitor = null
		this.#layoutStore = new DesktopLayoutStore()

		const [files, setFiles] = createState<DesktopFile[]>([])
		const [gridMetrics, setGridMetrics] = createState<Record<string, GridMetrics>>({})
		const [connectedMonitors, setConnectedMonitors] = createState<Set<string>>(new Set())
		const [primaryMonitor, setPrimaryMonitor] = createState("")
		const [layoutRevision, setLayoutRevision] = createState(0)
		const [clipboardState, setClipboardState] = createState<ClipboardPayload | null>(null)

		this.#files = files
		this.#setFiles = setFiles
		this.#gridMetrics = gridMetrics
		this.#setGridMetrics = setGridMetrics
		this.#connectedMonitors = connectedMonitors
		this.#setConnectedMonitors = setConnectedMonitors
		this.#primaryMonitor = primaryMonitor
		this.#setPrimaryMonitor = setPrimaryMonitor
		this.#layoutRevision = layoutRevision
		this.#setLayoutRevision = setLayoutRevision
		this.#clipboardState = clipboardState
		this.#setClipboardState = setClipboardState

		this.#reload()
		this.#watch()
	}

	get clipboard(): Accessor<ClipboardPayload | null> {
		return this.#clipboardState
	}

	#reload(preferredMonitorId?: string) {
		const files = loadDesktopFiles()
		if (files instanceof Error) {
			console.error("desktop.loadDesktopFiles: Failed to load desktop files", files)
			return
		}

		this.#layoutStore.syncPaths(files, preferredMonitorId?.trim() || this.#primaryMonitor() || this.#layoutStore.fallbackMonitor())
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

	#bumpRevision(): void {
		this.#setLayoutRevision(this.#layoutRevision() + 1)
	}

	grid(monitorId: string): Grid {
		const id = this.#layoutStore.normalizeMonitorId(monitorId)
		const cached = this.#grids.get(id)
		if (cached)
			return cached

		const visible = createComputed((): ProjectedGridView => {
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
		const key = this.#layoutStore.ensureMonitor(id)
		const prevGrid = this.#layoutStore.gridOf(key)
		let positionsChanged = false

		if (prevGrid && prevGrid.columns !== metrics.columns) {
			const slotCount = metrics.rows * metrics.columns
			const remapped = remapSlotsAcrossColumns(this.#layoutStore.positionsOf(key), prevGrid.columns, metrics.columns, slotCount)
			positionsChanged = this.#layoutStore.setPositions(key, remapped)
		}

		this.#layoutStore.setGrid(key, metrics)
		this.#setGridMetrics({ ...this.#gridMetrics(), [key]: metrics })
		if (this.#normalizeOwnedPositions(key, this.#files(), metrics))
			positionsChanged = true
		if (positionsChanged)
			this.#bumpRevision()
	}

	setMonitors(ids: string[], primaryId: string): void {
		this.#setConnectedMonitors(new Set(ids.map(id => this.#layoutStore.normalizeMonitorId(id))))
		this.#setPrimaryMonitor(this.#layoutStore.normalizeMonitorId(primaryId))
	}

	#computeVisible(id: string): ProjectedGridView {
		const files = this.#files()
		const metrics = this.#gridMetrics()[id]
		this.#layoutRevision()

		const owned = this.#computeOwnedVisible(id, files, metrics)
		if (!metrics || this.#primaryMonitor() !== id)
			return owned

		const disconnected = this.#filesFromDisconnectedMonitors(files, id, this.#connectedMonitors())
		return this.#projectDisconnectedFiles(disconnected, owned, metrics)
	}

	#computeOwnedVisible(id: string, files: DesktopFile[], metrics?: GridMetrics): ProjectedGridView {
		const ownedFiles = this.#layoutStore.filesOnMonitor(files, id)
		if (!metrics)
			return { files: ownedFiles, positions: this.#layoutStore.positionsOf(id) }
		const totalSlots = metrics.rows * metrics.columns
		return {
			files: ownedFiles,
			positions: normalizePositions(ownedFiles, this.#layoutStore.positionsOf(id), totalSlots, metrics.columns),
		}
	}

	#filesFromDisconnectedMonitors(files: DesktopFile[], targetId: string, connected: Set<string>): DesktopFile[] {
		return files.filter(file => {
			const home = this.monitorOf(file.path)
			return !!home && home !== targetId && !connected.has(home)
		})
	}

	#projectDisconnectedFiles(projectedFiles: DesktopFile[], owned: ProjectedGridView, metrics: GridMetrics): ProjectedGridView {
		const totalSlots = metrics.rows * metrics.columns
		const usedSlots = new Set(Object.values(owned.positions))
		const visibleFiles = [...owned.files]
		const visiblePositions = { ...owned.positions }
		const firstFreeSlot = (): number | null => {
			for (let slot = 0; slot < totalSlots; slot += 1)
				if (!usedSlots.has(slot)) return slot
			return null
		}
		const byHomeSlot = [...projectedFiles].sort((a, b) => {
			const aSlot = this.#layoutStore.homeSlotOf(a.path) ?? Number.MAX_SAFE_INTEGER
			const bSlot = this.#layoutStore.homeSlotOf(b.path) ?? Number.MAX_SAFE_INTEGER
			return aSlot !== bSlot ? aSlot - bSlot : a.name.localeCompare(b.name)
		})

		for (const file of byHomeSlot) {
			const home = this.#layoutStore.homeSlotOf(file.path)
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
		const owned = this.#layoutStore.filesOnMonitor(files, id)
		const slotCount = metrics.rows * metrics.columns
		const positions = normalizePositions(owned, this.#layoutStore.positionsOf(id), slotCount, metrics.columns)
		return this.#layoutStore.setPositions(id, positions)
	}

	#normalizeKnownPositions(files: DesktopFile[]) {
		for (const [id, metrics] of Object.entries(this.#gridMetrics())) {
			this.#normalizeOwnedPositions(id, files, metrics)
		}
	}

	#move(targetId: string, paths: string[], targetSlot: number, anchor?: string): void {
		const uniquePaths = Array.from(new Set(paths)).filter(Boolean)
		if (uniquePaths.length === 0)
			return

		const metrics = this.#gridMetrics()[targetId]
		if (!metrics)
			return

		const anchorPath = anchor ?? uniquePaths[0]
		const sourceMonitor = this.monitorOf(anchorPath) ?? this.monitorOf(uniquePaths[0]) ?? targetId

		if (this.#layoutStore.normalizeMonitorId(sourceMonitor) === targetId) {
			this.#moveWithinMonitor(targetId, uniquePaths, anchorPath, targetSlot, metrics)
			return
		}
		this.#moveAcrossMonitors(sourceMonitor, targetId, uniquePaths, anchorPath, targetSlot, metrics)
	}

	#moveWithinMonitor(targetId: string, paths: string[], anchorPath: string, targetSlot: number, metrics: GridMetrics): void {
		const target = this.#computeVisible(targetId)
		this.#layoutStore.assignPaths(paths, targetId)
		const nextPositions = movePathsToSlot(
			{ positions: target.positions, columns: metrics.columns, slotCount: metrics.rows * metrics.columns },
			target.files,
			{ paths, anchorPath, targetSlot },
		)
		const ownedPaths = new Set(this.#layoutStore.filesOnMonitor(this.#files(), targetId).map(file => file.path))
		this.#layoutStore.setPositions(targetId, pickPositions(ownedPaths, nextPositions))
		this.#bumpRevision()
	}

	#moveAcrossMonitors(
		sourceMonitor: string,
		targetId: string,
		paths: string[],
		anchorPath: string,
		targetSlot: number,
		metrics: GridMetrics,
	): void {
		const target = this.#computeVisible(targetId)
		const columns = metrics.columns
		const sourcePositions = this.#layoutStore.positionsOf(sourceMonitor)
		const sourceCols = this.#layoutStore.gridOf(sourceMonitor)?.columns ?? columns
		const targetPositions = { ...target.positions }
		for (const path of paths)
			delete targetPositions[path]

		const nextTarget = movePathsToGrid(
			{ positions: sourcePositions, columns: sourceCols },
			{ positions: targetPositions, columns, slotCount: metrics.rows * metrics.columns },
			{ paths, anchorPath, targetSlot },
		)

		this.#layoutStore.assignPaths(paths, targetId)

		const targetPaths = new Set(this.#layoutStore.filesOnMonitor(this.#files(), targetId).map(file => file.path))
		this.#layoutStore.setPositions(targetId, pickPositions(targetPaths, nextTarget))

		this.#bumpRevision()
	}

	open(paths: string[]): void {
		for (const path of paths) {
			const error = openFile(path)
			if (error instanceof Error)
				console.error("desktop.open: Failed to open desktop file", error)
		}
	}

	copy(paths: string[]): void {
		this.#setClipboard("copy", paths)
	}

	cut(paths: string[]): void {
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

	async cancelCut(): Promise<void> {
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
		const payload = current || this.#clipboardState()
		if (!payload || payload.files.length === 0)
			return

		const monitor = monitorId.trim() || this.#layoutStore.fallbackMonitor()
		const error = await pasteFiles(payload.files, payload.operation, () => this.#reload(monitor))
		if (error instanceof Error) {
			console.error("desktop.pasteFiles: Failed to paste desktop files", error)
			return
		}

		if (payload.operation === "cut")
			this.#setClipboardState(null)
	}

	remove(paths: string[], opts: { permanently?: boolean } = {}): void {
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

		this.#layoutStore.assignPaths([path], monitorId)
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

		this.#layoutStore.renamePath(target, path)
		this.#setFiles(this.#files().map(file => file.path === target
			? { ...file, path, name: path.split("/").pop() ?? file.name }
			: file))
		this.#bumpRevision()
		return path
	}

	monitorOf(path: string): string | null {
		return this.#layoutStore.monitorOf(path)
	}

	vfunc_finalize(): void {
		this.#monitor?.cancel()
		this.#monitor = null
		this.#refresh.cancel()
		this.#layoutStore.dispose()
		super.vfunc_finalize()
	}
}

export const desktop = DesktopService.get_default()
