// Finds free icon slots and moves icons within or between monitor grids.

import type { DesktopFile } from "./files"

export type SlotLayout = {
	positions: Record<string, number>
	columns: number
	slotCount: number
}

export type SlotMove = {
	paths: string[]
	anchorPath: string
	targetSlot: number
}

export function pickPositions(paths: Set<string>, positions: Record<string, number>): Record<string, number> {
	const picked: Record<string, number> = {}
	for (const [path, slot] of Object.entries(positions)) {
		if (paths.has(path))
			picked[path] = slot
	}
	return picked
}

export function remapSlotsAcrossColumns(
	positions: Record<string, number>,
	previousColumns: number,
	nextColumns: number,
	slotCount: number,
): Record<string, number> {
	if (previousColumns <= 0 || nextColumns <= 0 || previousColumns === nextColumns)
		return positions

	const remapped: Record<string, number> = {}
	for (const [path, slot] of Object.entries(positions)) {
		const normalized = Math.max(0, Math.floor(slot))
		const row = Math.floor(normalized / previousColumns)
		const column = normalized % previousColumns
		const nextSlot = (row * nextColumns) + Math.min(column, nextColumns - 1)
		if (nextSlot >= 0 && nextSlot < slotCount)
			remapped[path] = nextSlot
	}
	return remapped
}

export function normalizePositions(
	fileList: DesktopFile[],
	current: Record<string, number>,
	slotCount: number,
	columns: number,
): Record<string, number> {
	const nextPositions: Record<string, number> = { ...current }
	const validPaths = new Set(fileList.map(file => file.path))
	Object.keys(nextPositions).forEach(path => {
		if (!validPaths.has(path)) delete nextPositions[path]
	})
	const used = new Set<number>()
	const placed = new Set<string>()

	for (const file of fileList) {
		const slot = nextPositions[file.path]
		if (slot != null && slot >= 0 && slot < slotCount && !used.has(slot)) {
			used.add(slot)
			placed.add(file.path)
		} else {
			delete nextPositions[file.path]
		}
	}

	const safeColumns = Math.max(1, columns)
	const rows = Math.max(1, Math.floor(slotCount / safeColumns))
	let cursor = 0
	const nextFreeSlot = () => {
		// New icons fill top-to-bottom before advancing to the next column.
		while (cursor < slotCount) {
			const slot = (cursor % rows) * safeColumns + Math.floor(cursor / rows)
			cursor += 1
			if (!used.has(slot)) return slot
		}
		return null
	}

	for (const file of fileList) {
		if (placed.has(file.path)) continue
		const slot = nextFreeSlot()
		if (slot != null) {
			nextPositions[file.path] = slot
			used.add(slot)
		}
	}
	return nextPositions
}

type DragOffset = { path: string, row: number, column: number }

function getDragOffsets(paths: string[], anchorPath: string, positions: Record<string, number>, columns: number): DragOffset[] {
	const safeColumns = Math.max(1, columns)
	const anchorSlot = positions[anchorPath] ?? positions[paths[0]] ?? 0
	const anchorRow = Math.floor(anchorSlot / safeColumns)
	const anchorColumn = anchorSlot % safeColumns
	return paths.map(path => {
		const slot = positions[path] ?? anchorSlot
		return {
			path,
			row: Math.floor(slot / safeColumns) - anchorRow,
			column: (slot % safeColumns) - anchorColumn,
		}
	})
}

function clamp(value: number, minimum: number, maximum: number): number {
	if (minimum > maximum) return minimum
	return Math.max(minimum, Math.min(maximum, value))
}

function getBoundedAnchor(targetSlot: number, columns: number, slotCount: number, offsets: DragOffset[]) {
	const safeColumns = Math.max(1, columns)
	const rows = Math.max(1, Math.floor(slotCount / safeColumns))
	const minimumRow = Math.min(...offsets.map(({ row }) => row))
	const maximumRow = Math.max(...offsets.map(({ row }) => row))
	const minimumColumn = Math.min(...offsets.map(({ column }) => column))
	const maximumColumn = Math.max(...offsets.map(({ column }) => column))
	return {
		row: clamp(Math.floor(targetSlot / safeColumns), -minimumRow, (rows - 1) - maximumRow),
		column: clamp(targetSlot % safeColumns, -minimumColumn, (safeColumns - 1) - maximumColumn),
	}
}

export function movePathsToSlot(layout: SlotLayout, files: DesktopFile[], move: SlotMove): Record<string, number> {
	const normalized = normalizePositions(files, layout.positions, layout.slotCount, layout.columns)
	const dragged = Array.from(new Set(move.paths)).filter(path => normalized[path] != null)
	if (dragged.length === 0) return normalized

	// A single icon swaps with its occupant; groups reject collisions to preserve their shape.
	if (dragged.length === 1) {
		const draggedPath = dragged[0]
		const sourceSlot = normalized[draggedPath]
		if (sourceSlot == null || sourceSlot === move.targetSlot) return normalized
		const next = { ...normalized }
		const occupiedPath = Object.entries(normalized).find(([path, slot]) => path !== draggedPath && slot === move.targetSlot)?.[0]
		next[draggedPath] = move.targetSlot
		if (occupiedPath) next[occupiedPath] = sourceSlot
		return next
	}

	const orderedDragged = [...dragged].sort((a, b) => (normalized[a] ?? 0) - (normalized[b] ?? 0))
	const anchorPath = orderedDragged.includes(move.anchorPath) ? move.anchorPath : orderedDragged[0]
	const fromSlot = normalized[anchorPath]
	if (fromSlot == null || fromSlot === move.targetSlot) return normalized
	const draggedPaths = new Set(orderedDragged)
	const occupiedByOthers = new Set(files
		.filter(file => !draggedPaths.has(file.path))
		.map(file => normalized[file.path])
		.filter((slot): slot is number => slot != null))
	const offsets = getDragOffsets(orderedDragged, anchorPath, normalized, layout.columns)
	const anchor = getBoundedAnchor(move.targetSlot, layout.columns, layout.slotCount, offsets)
	const desiredSlots = new Map<string, number>()
	for (const offset of offsets) {
		const desiredSlot = ((anchor.row + offset.row) * layout.columns) + anchor.column + offset.column
		if (occupiedByOthers.has(desiredSlot)) return normalized
		desiredSlots.set(offset.path, desiredSlot)
	}
	const next = { ...normalized }
	desiredSlots.forEach((slot, path) => { next[path] = slot })
	return next
}

export function movePathsToGrid(
	source: Pick<SlotLayout, "positions" | "columns">,
	target: SlotLayout,
	move: SlotMove,
): Record<string, number> {
	const paths = Array.from(new Set(move.paths)).filter(Boolean)
	if (paths.length === 0) return { ...target.positions }
	const columns = Math.max(1, target.columns)
	const offsets = getDragOffsets(paths, move.anchorPath, source.positions, source.columns)
	const anchor = getBoundedAnchor(move.targetSlot, columns, target.slotCount, offsets)
	const taken = new Set(Object.values(target.positions))
	const next = { ...target.positions }
	function firstFreeSlot() {
		for (let slot = 0; slot < target.slotCount; slot += 1)
			if (!taken.has(slot)) return slot
		return null
	}
	for (const offset of offsets) {
		let slot = ((anchor.row + offset.row) * columns) + anchor.column + offset.column
		// Cross-grid moves keep relative slots when possible, then use the first free target slot.
		if (slot < 0 || slot >= target.slotCount || taken.has(slot)) {
			const freeSlot = firstFreeSlot()
			if (freeSlot == null) continue
			slot = freeSlot
		}
		next[offset.path] = slot
		taken.add(slot)
	}
	return next
}
