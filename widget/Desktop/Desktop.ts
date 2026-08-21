// Owns plain desktop data and applies direct grid, file, and interaction operations.

import app from "ags/gtk4/app"
import { createState } from "ags"
import { readFile } from "ags/file"
import { Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import env from "$lib/env"
import { attempt } from "$lib/result"
import { debounce } from "$lib/time"

import {
	clearClipboardFilePayload,
	createDesktopFolder,
	createDesktopLauncher,
	createDesktopTextFile,
	DESKTOP_PATH,
	importDesktopFiles,
	loadDesktopFiles,
	openPath,
	openPathWithChooser,
	pasteFilesToDesktop,
	permanentlyDeleteFiles,
	readClipboardFilePayload,
	renameFile,
	trashFiles,
	writeClipboardFilePayload,
} from "./FileOperations"
import type {
	ClipboardFilePayload,
	DesktopFile,
	DesktopLauncherSpec,
} from "./FileOperations"
import {
	expandGridMetrics,
	movePathsToGrid,
	movePathsToSlot,
	pickPositions,
	reconcileGridPositions,
	remapSlotsAcrossColumns,
} from "./GridGeometry"
import type { GridMetrics } from "./GridGeometry"

const cacheFile = `${env.paths.cache.base}/desktop-layout.json`
const DEFAULT_MONITOR = "monitor:default"

type DesktopPlacement = {
	monitor: string
	slot?: number
}

type DesktopLayout = {
	version: 3
	placements: Record<string, DesktopPlacement>
	columns: Record<string, number>
}

export type DesktopGridData = {
	id: string
	metrics: GridMetrics | null
	files: DesktopFile[]
	positions: Record<string, number>
}

type PathEntry = { path: string }

type LegacyMonitor = {
	positions: Record<string, number>
	columns?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalizeMonitorId(monitorId: string): string {
	const normalized = monitorId.trim().toLowerCase()
	return normalized || DEFAULT_MONITOR
}

function sanitizeSlot(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: 0
}

function sanitizeOptionalSlot(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: undefined
}

function sanitizeColumnCount(value: unknown): number | undefined {
	const columns = sanitizeSlot(value)
	return columns > 0 ? columns : undefined
}

function decodeLegacyMonitors(value: unknown): Record<string, LegacyMonitor> {
	if (!isRecord(value)) return {}
	const monitors: Record<string, LegacyMonitor> = {}
	for (const [rawId, rawMonitor] of Object.entries(value)) {
		if (!isRecord(rawMonitor)) continue
		const positions: Record<string, number> = {}
		if (isRecord(rawMonitor.positions)) {
			for (const [path, slot] of Object.entries(rawMonitor.positions))
				if (path) positions[path] = sanitizeSlot(slot)
		}
		const columns = isRecord(rawMonitor.grid)
			? sanitizeColumnCount(rawMonitor.grid.columns)
			: undefined
		monitors[normalizeMonitorId(rawId)] = { positions, columns }
	}
	return monitors
}

function decodeLayout(value: unknown): DesktopLayout {
	const layout: DesktopLayout = { version: 3, placements: {}, columns: {} }
	if (!isRecord(value)) return layout

	if (isRecord(value.placements)) {
		for (const [path, rawPlacement] of Object.entries(value.placements)) {
			if (!path || !isRecord(rawPlacement)) continue
			const monitor = normalizeMonitorId(
				typeof rawPlacement.monitor === "string" ? rawPlacement.monitor : "",
			)
			const slot = sanitizeOptionalSlot(rawPlacement.slot)
			layout.placements[path] = slot == null ? { monitor } : { monitor, slot }
		}
	}

	if (value.version === 3) {
		if (isRecord(value.columns)) {
			for (const [rawId, rawColumns] of Object.entries(value.columns)) {
				const columns = sanitizeColumnCount(rawColumns)
				if (columns) layout.columns[normalizeMonitorId(rawId)] = columns
			}
		}
		return layout
	}

	if (value.version === 2) {
		if (isRecord(value.grids)) {
			for (const [rawId, rawGrid] of Object.entries(value.grids)) {
				if (!isRecord(rawGrid)) continue
				const columns = sanitizeColumnCount(rawGrid.columns)
				if (columns) layout.columns[normalizeMonitorId(rawId)] = columns
			}
		}
		return layout
	}

	const monitors = decodeLegacyMonitors(value.monitors)
	for (const [id, monitor] of Object.entries(monitors)) {
		if (monitor.columns) layout.columns[id] = monitor.columns
		for (const [path, slot] of Object.entries(monitor.positions))
			layout.placements[path] = { monitor: id, slot }
	}
	if (isRecord(value.entries)) {
		for (const [path, rawMonitor] of Object.entries(value.entries)) {
			if (!path || typeof rawMonitor !== "string") continue
			const monitor = normalizeMonitorId(rawMonitor)
			const slot =
				monitors[monitor]?.positions[path] ?? layout.placements[path]?.slot
			layout.placements[path] = slot == null ? { monitor } : { monitor, slot }
		}
	}
	return layout
}

function loadLayout(): DesktopLayout {
	if (!GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) return decodeLayout({})
	const result = attempt((): unknown => JSON.parse(readFile(cacheFile) || "{}"))
	if (!result.ok)
		console.error(
			"desktop.loadLayout: Failed to load desktop layout",
			result.err,
		)
	return decodeLayout(result.ok ? result.value : {})
}

function placementsEqual(
	a: Record<string, DesktopPlacement>,
	b: Record<string, DesktopPlacement>,
): boolean {
	const paths = Object.keys(a)
	return (
		paths.length === Object.keys(b).length &&
		paths.every(
			(path) =>
				a[path].monitor === b[path]?.monitor && a[path].slot === b[path]?.slot,
		)
	)
}

function positionsOf(
	layout: DesktopLayout,
	monitorId: string,
): Record<string, number> {
	const id = normalizeMonitorId(monitorId)
	const positions: Record<string, number> = {}
	for (const [path, placement] of Object.entries(layout.placements))
		if (placement.monitor === id && placement.slot != null)
			positions[path] = placement.slot
	return positions
}

function filesOnMonitor<T extends PathEntry>(
	layout: DesktopLayout,
	files: T[],
	monitorId: string,
): T[] {
	const id = normalizeMonitorId(monitorId)
	return files.filter((file) => layout.placements[file.path]?.monitor === id)
}

function fallbackMonitor(layout: DesktopLayout): string {
	return (
		Object.keys(layout.columns)[0] ??
		Object.values(layout.placements)[0]?.monitor ??
		DEFAULT_MONITOR
	)
}

function assignPaths(
	layout: DesktopLayout,
	paths: string[],
	monitorId: string,
): DesktopLayout {
	const monitor = normalizeMonitorId(monitorId)
	const placements = { ...layout.placements }
	for (const path of new Set(paths)) {
		if (!path) continue
		const current = placements[path]
		placements[path] =
			current?.monitor === monitor && current.slot != null
				? { monitor, slot: current.slot }
				: { monitor }
	}
	return placementsEqual(layout.placements, placements)
		? layout
		: { ...layout, placements }
}

function setPositions(
	layout: DesktopLayout,
	monitorId: string,
	positions: Record<string, number>,
): DesktopLayout {
	const monitor = normalizeMonitorId(monitorId)
	const placements = { ...layout.placements }
	for (const [path, placement] of Object.entries(placements)) {
		if (placement.monitor !== monitor) continue
		placements[path] =
			path in positions
				? { monitor, slot: sanitizeSlot(positions[path]) }
				: { monitor }
	}
	return placementsEqual(layout.placements, placements)
		? layout
		: { ...layout, placements }
}

function setColumnCount(
	layout: DesktopLayout,
	monitorId: string,
	columns: number,
): DesktopLayout {
	const id = normalizeMonitorId(monitorId)
	if (layout.columns[id] === columns) return layout
	return { ...layout, columns: { ...layout.columns, [id]: columns } }
}

function syncPaths(
	layout: DesktopLayout,
	files: PathEntry[],
	fallbackMonitorId: string,
): DesktopLayout {
	const fallback = normalizeMonitorId(fallbackMonitorId)
	const validPaths = new Set(files.map((file) => file.path))
	const placements: Record<string, DesktopPlacement> = {}
	for (const [path, placement] of Object.entries(layout.placements)) {
		if (!validPaths.has(path)) continue
		const monitor =
			placement.monitor === DEFAULT_MONITOR && fallback !== DEFAULT_MONITOR
				? fallback
				: normalizeMonitorId(placement.monitor)
		placements[path] =
			placement.slot == null
				? { monitor }
				: { monitor, slot: sanitizeSlot(placement.slot) }
	}
	for (const file of files)
		if (!placements[file.path]) placements[file.path] = { monitor: fallback }
	return placementsEqual(layout.placements, placements)
		? layout
		: { ...layout, placements }
}

function renamePlacement(
	layout: DesktopLayout,
	oldPath: string,
	newPath: string,
): DesktopLayout {
	const placement = layout.placements[oldPath]
	if (!placement || !oldPath || !newPath || oldPath === newPath) return layout
	const placements = { ...layout.placements, [newPath]: placement }
	delete placements[oldPath]
	return { ...layout, placements }
}

const [desktopFiles, setDesktopFiles] = createState<DesktopFile[]>([])
const [desktopLayout, setDesktopLayout] = createState(loadLayout())
const [gridMetrics, setGridMetrics] = createState<Record<string, GridMetrics>>(
	{},
)
const [connectedMonitors, setConnectedMonitors] = createState<Set<string>>(
	new Set(),
)
const [primaryMonitor, setPrimaryMonitor] = createState("")
const [desktopClipboard, updateDesktopClipboard] =
	createState<ClipboardFilePayload | null>(null)
export { desktopClipboard }

const saveLayout = debounce(500, () => {
	const result = attempt(() =>
		GLib.file_set_contents(
			cacheFile,
			JSON.stringify(desktopLayout.peek(), null, 2),
		),
	)
	if (!result.ok)
		console.error("desktop.save: Failed to save desktop layout", result.err)
})

function updateLayout(next: DesktopLayout): boolean {
	if (next === desktopLayout.peek()) return false
	setDesktopLayout(next)
	saveLayout.call()
	return true
}

function normalizeOwnedPositions(
	layout: DesktopLayout,
	id: string,
	files: DesktopFile[],
	metrics: GridMetrics,
): DesktopLayout {
	const owned = filesOnMonitor(layout, files, id)
	const expandedMetrics = expandGridMetrics(metrics, owned.length)
	const positions = reconcileGridPositions(
		owned,
		positionsOf(layout, id),
		expandedMetrics.rows * expandedMetrics.columns,
		expandedMetrics.columns,
	)
	return setPositions(layout, id, positions)
}

function normalizeKnownPositions(
	layout: DesktopLayout,
	files: DesktopFile[],
): DesktopLayout {
	let next = layout
	for (const [id, metrics] of Object.entries(gridMetrics.peek()))
		next = normalizeOwnedPositions(next, id, files, metrics)
	return next
}

function reloadDesktopFiles(preferredMonitorId?: string): void {
	const result = loadDesktopFiles()
	if (!result.ok) {
		console.error(
			"desktop.loadDesktopFiles: Failed to load desktop files",
			result.err,
		)
		return
	}
	const files = result.value
	const current = desktopLayout.peek()
	const preferred =
		preferredMonitorId?.trim() ||
		primaryMonitor.peek() ||
		fallbackMonitor(current)
	const next = normalizeKnownPositions(
		syncPaths(current, files, preferred),
		files,
	)
	updateLayout(next)
	setDesktopFiles(files)
}

const refreshDesktopFiles = debounce(120, reloadDesktopFiles)
let desktopDirectoryMonitor: Gio.FileMonitor | null = null
let activeTransfers = 0

function beginDesktopTransfer(): void {
	activeTransfers += 1
	refreshDesktopFiles.cancel()
}

function finishDesktopTransfer(
	createdPaths: string[],
	monitorId: string,
): void {
	if (createdPaths.length > 0)
		updateLayout(assignPaths(desktopLayout.peek(), createdPaths, monitorId))
	activeTransfers = Math.max(0, activeTransfers - 1)
	if (activeTransfers === 0) reloadDesktopFiles()
}

function watchDesktopDirectory(): void {
	if (desktopDirectoryMonitor) return
	const result = attempt(() => {
		const directory = Gio.File.new_for_path(DESKTOP_PATH)
		desktopDirectoryMonitor = directory.monitor_directory(
			Gio.FileMonitorFlags.WATCH_MOVES,
			null,
		)
		desktopDirectoryMonitor.connect("changed", () => {
			if (activeTransfers === 0) refreshDesktopFiles.call()
		})
	})
	if (!result.ok)
		console.error(
			"desktop.watchDesktopDir: Failed to watch desktop directory",
			result.err,
		)
}

export function getDesktopGrid(monitorId: string): DesktopGridData {
	const id = normalizeMonitorId(monitorId)
	const layout = desktopLayout()
	const files = desktopFiles()
	const baseMetrics = gridMetrics()[id] ?? null
	const ownedFiles = filesOnMonitor(layout, files, id)
	const disconnected =
		baseMetrics && primaryMonitor() === id
			? files.filter((file) => {
					const home = layout.placements[file.path]?.monitor
					return !!home && home !== id && !connectedMonitors().has(home)
				})
			: []
	const metrics = baseMetrics
		? expandGridMetrics(baseMetrics, ownedFiles.length + disconnected.length)
		: null
	const ownedPositions = metrics
		? reconcileGridPositions(
				ownedFiles,
				positionsOf(layout, id),
				metrics.rows * metrics.columns,
				metrics.columns,
			)
		: positionsOf(layout, id)
	if (!metrics || disconnected.length === 0)
		return { id, metrics, files: ownedFiles, positions: ownedPositions }

	const usedSlots = new Set(Object.values(ownedPositions))
	const visibleFiles = [...ownedFiles]
	const visiblePositions = { ...ownedPositions }
	const totalSlots = metrics.rows * metrics.columns
	const firstFreeSlot = (): number | null => {
		for (let slot = 0; slot < totalSlots; slot += 1)
			if (!usedSlots.has(slot)) return slot
		return null
	}
	const ordered = [...disconnected].sort((a, b) => {
		const aSlot = layout.placements[a.path]?.slot ?? Number.MAX_SAFE_INTEGER
		const bSlot = layout.placements[b.path]?.slot ?? Number.MAX_SAFE_INTEGER
		return aSlot !== bSlot ? aSlot - bSlot : a.name.localeCompare(b.name)
	})
	for (const file of ordered) {
		const home = layout.placements[file.path]?.slot
		const homeFree = home != null && home < totalSlots && !usedSlots.has(home)
		const slot = homeFree ? home : firstFreeSlot()
		if (slot == null) continue
		usedSlots.add(slot)
		visibleFiles.push(file)
		visiblePositions[file.path] = slot
	}
	return { id, metrics, files: visibleFiles, positions: visiblePositions }
}

export function resizeDesktopGrid(
	monitorId: string,
	metrics: GridMetrics,
): void {
	const id = normalizeMonitorId(monitorId)
	let layout = desktopLayout.peek()
	const previousColumns = layout.columns[id]
	if (previousColumns && previousColumns !== metrics.columns) {
		const owned = filesOnMonitor(layout, desktopFiles.peek(), id)
		const expandedMetrics = expandGridMetrics(metrics, owned.length)
		const remapped = remapSlotsAcrossColumns(
			positionsOf(layout, id),
			previousColumns,
			metrics.columns,
			expandedMetrics.rows * expandedMetrics.columns,
		)
		layout = setPositions(layout, id, remapped)
	}
	layout = setColumnCount(layout, id, metrics.columns)
	setGridMetrics({ ...gridMetrics.peek(), [id]: metrics })
	layout = normalizeOwnedPositions(layout, id, desktopFiles.peek(), metrics)
	updateLayout(layout)
}

export function setDesktopMonitors(ids: string[], primaryId: string): void {
	setConnectedMonitors(new Set(ids.map(normalizeMonitorId)))
	setPrimaryMonitor(normalizeMonitorId(primaryId))
}

export function monitorOfDesktopPath(path: string): string | null {
	return path ? (desktopLayout.peek().placements[path]?.monitor ?? null) : null
}

export function moveDesktopFiles(
	targetMonitorId: string,
	paths: string[],
	targetSlot: number,
	anchor?: string,
): void {
	const targetId = normalizeMonitorId(targetMonitorId)
	const uniquePaths = [...new Set(paths)].filter(Boolean)
	if (uniquePaths.length === 0) return
	const target = getDesktopGrid(targetId)
	let metrics = target.metrics
	if (!metrics) return

	const layout = desktopLayout.peek()
	const anchorPath = anchor ?? uniquePaths[0]
	const sourceId =
		monitorOfDesktopPath(anchorPath) ??
		monitorOfDesktopPath(uniquePaths[0]) ??
		targetId
	if (normalizeMonitorId(sourceId) !== targetId) {
		const targetPaths = new Set(target.files.map((file) => file.path))
		const incoming = uniquePaths.filter((path) => !targetPaths.has(path)).length
		metrics = expandGridMetrics(metrics, target.files.length + incoming)
	}
	let next = layout
	if (normalizeMonitorId(sourceId) === targetId) {
		next = assignPaths(next, uniquePaths, targetId)
		const positions = movePathsToSlot(
			{
				positions: target.positions,
				columns: metrics.columns,
				slotCount: metrics.rows * metrics.columns,
			},
			target.files,
			{ paths: uniquePaths, anchorPath, targetSlot },
		)
		const owned = new Set(
			filesOnMonitor(next, desktopFiles.peek(), targetId).map(
				(file) => file.path,
			),
		)
		next = setPositions(next, targetId, pickPositions(owned, positions))
	} else {
		const targetPositions = { ...target.positions }
		for (const path of uniquePaths) delete targetPositions[path]
		const positions = movePathsToGrid(
			{
				positions: positionsOf(layout, sourceId),
				columns:
					layout.columns[normalizeMonitorId(sourceId)] ?? metrics.columns,
			},
			{
				positions: targetPositions,
				columns: metrics.columns,
				slotCount: metrics.rows * metrics.columns,
			},
			{ paths: uniquePaths, anchorPath, targetSlot },
		)
		next = assignPaths(next, uniquePaths, targetId)
		const owned = new Set(
			filesOnMonitor(next, desktopFiles.peek(), targetId).map(
				(file) => file.path,
			),
		)
		next = setPositions(next, targetId, pickPositions(owned, positions))
	}
	updateLayout(next)
}

export function openDesktopFiles(paths: string[]): void {
	for (const path of paths) {
		const result = openPath(path)
		if (!result.ok)
			console.error("desktop.open: Failed to open desktop file", result.err)
	}
}

export async function openDesktopFileWith(
	path: string,
	window: Gtk.Window,
): Promise<void> {
	if (!path) return
	const result = await openPathWithChooser(path, window)
	if (!result.ok)
		console.error(
			"desktop.openWith: Failed to open application chooser",
			result.err,
		)
}

export function setDesktopClipboard(
	operation: "copy" | "cut",
	paths: string[],
): void {
	const files = [...new Set(paths)].filter(Boolean)
	if (files.length === 0) return
	void writeClipboardFilePayload(operation, files).then((result) => {
		if (!result.ok)
			console.error(
				"desktop.setClipboardFiles: Failed to set desktop clipboard",
				result.err,
			)
	})
	updateDesktopClipboard({ operation, files })
}

export async function cancelDesktopCut(): Promise<void> {
	const current = await readClipboardFilePayload()
	if (current?.operation === "cut") {
		const result = await clearClipboardFilePayload()
		if (!result.ok)
			console.error(
				"desktop.clearClipboardFiles: Failed to clear desktop clipboard",
				result.err,
			)
	}
	if (desktopClipboard.peek()?.operation === "cut") updateDesktopClipboard(null)
}

export async function pasteDesktopFiles(monitorId: string): Promise<void> {
	const payload = (await readClipboardFilePayload()) || desktopClipboard.peek()
	if (!payload?.files.length) return
	const monitor = monitorId.trim() || fallbackMonitor(desktopLayout.peek())
	let createdPaths: string[] = []
	beginDesktopTransfer()
	try {
		const result = await pasteFilesToDesktop(payload.files, payload.operation)
		createdPaths = result.createdPaths
		if (result.failures.length > 0) {
			console.error(
				"desktop.pasteFiles: Failed to paste some desktop files",
				result.failures,
			)
			return
		}
		if (payload.operation === "cut") updateDesktopClipboard(null)
	} finally {
		finishDesktopTransfer(createdPaths, monitor)
	}
}

export async function importFilesToDesktop(
	paths: string[],
	monitorId: string,
	operation: "copy" | "move",
): Promise<void> {
	let createdPaths: string[] = []
	beginDesktopTransfer()
	try {
		const result = await importDesktopFiles(paths, operation)
		createdPaths = result.createdPaths
		if (result.failures.length > 0)
			console.error(
				"desktop.importFiles: Failed to import some desktop files",
				result.failures,
			)
	} finally {
		finishDesktopTransfer(createdPaths, monitorId)
	}
}

export function removeDesktopFiles(
	paths: string[],
	opts: { permanently?: boolean } = {},
): void {
	if (paths.length === 0) return
	const result = opts.permanently
		? permanentlyDeleteFiles(paths)
		: trashFiles(paths)
	if (!result.ok) {
		console.error("desktop.remove: Failed to remove desktop files", result.err)
		return
	}
	reloadDesktopFiles()
}

function rememberCreatedPath(
	result: ReturnType<typeof createDesktopFolder>,
	monitorId: string,
) {
	if (!result.ok) return null
	updateLayout(assignPaths(desktopLayout.peek(), [result.value], monitorId))
	reloadDesktopFiles(monitorId)
	return result.value
}

export function createDesktopFolderOn(monitorId: string): string | null {
	const result = createDesktopFolder()
	if (!result.ok)
		console.error(
			"desktop.createFolder: Failed to create desktop folder",
			result.err,
		)
	return rememberCreatedPath(result, monitorId)
}

export function createDesktopTextFileOn(monitorId: string): string | null {
	const result = createDesktopTextFile()
	if (!result.ok)
		console.error(
			"desktop.createTextFile: Failed to create desktop text file",
			result.err,
		)
	return rememberCreatedPath(result, monitorId)
}

export function createDesktopLauncherOn(
	monitorId: string,
	spec: DesktopLauncherSpec,
): string | null {
	const result = createDesktopLauncher(spec)
	if (!result.ok)
		console.error(
			"desktop.createLauncher: Failed to create desktop launcher",
			result.err,
		)
	return rememberCreatedPath(result, monitorId)
}

function renameDesktopFile(target: string, name: string): string | null {
	if (!target || !name.trim()) return null
	const result = renameFile(target, name)
	if (!result.ok) {
		console.error("desktop.rename: Failed to rename desktop file", result.err)
		return null
	}
	const path = result.value
	updateLayout(renamePlacement(desktopLayout.peek(), target, path))
	setDesktopFiles(
		desktopFiles.peek().map((file) =>
			file.path === target
				? {
						...file,
						path,
						name: path.split("/").pop() ?? file.name,
						displayName: path.toLowerCase().endsWith(".desktop")
							? file.displayName
							: undefined,
					}
				: file,
		),
	)
	return path
}

const [selected, setSelected] = createState<string[]>([])
const [pressed, setPressed] = createState<string | null>(null)
const [renamePath, setRenamePath] = createState<string | null>(null)
const [renameValue, setRenameValue] = createState("")
const roots = new Set<Gtk.Widget>()

export const desktopInteraction = {
	selected,
	pressed,
	select: setSelected,
	press: setPressed,
	redraw() {
		idle(() => roots.forEach((root) => root.queue_draw()))
	},
	roots: {
		add(root: Gtk.Widget) {
			roots.add(root)
		},
		delete(root: Gtk.Widget) {
			roots.delete(root)
		},
	},
	rename: {
		path: renamePath,
		value: renameValue,
		setValue: setRenameValue,
		begin(path: string) {
			const name = path.split("/").pop() || ""
			if (renamePath.peek() === path) {
				setRenamePath(null)
				idle(() => {
					setRenameValue(name)
					setRenamePath(path)
				})
			} else {
				setRenameValue(name)
				setRenamePath(path)
			}
			setSelected([path])
		},
		commit() {
			const target = renamePath.peek()
			const name = renameValue.peek().trim()
			if (!target || !name || target.split("/").pop() === name) {
				setRenamePath(null)
				return
			}
			const path = renameDesktopFile(target, name)
			if (path) setSelected([path])
			setRenamePath(null)
		},
		cancel() {
			setRenamePath(null)
		},
	},
}

reloadDesktopFiles()
saveLayout.call()
watchDesktopDirectory()
app.connect("shutdown", () => {
	desktopDirectoryMonitor?.cancel()
	desktopDirectoryMonitor = null
	refreshDesktopFiles.cancel()
	if (saveLayout.pending) saveLayout.flush()
	saveLayout.cancel()
})
