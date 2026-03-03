import type { DesktopFile } from "./files"

export type DesktopIconSize = "small" | "medium" | "large" | "extralarge"

export type DesktopIconMetrics = {
	iconPx: number
	cellPx: number
	labelChars: number
}

export type GridMetrics = {
	cellWidth: number
	cellHeight: number
	rows: number
	columns: number
	offsetX: number
	offsetY: number
	paddingRight: number
	paddingBottom: number
}

export type SlotRect = {
	x: number
	y: number
	width: number
	height: number
}

export type WorkAreaPadding = {
	left: number
	right: number
	top: number
	bottom: number
}

export type StoredGrid = {
	rows: number
	columns: number
	cellWidth: number
	cellHeight: number
}

export type StoredMonitorLayout = {
	positions: Record<string, number>
	grid: StoredGrid | null
}

export type StoredLayout = {
	version: 1
	entries: Record<string, string>
	monitors: Record<string, StoredMonitorLayout>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function normalizeMonitorId(monitorId: string) {
	const normalized = monitorId.trim().toLowerCase()
	return normalized.length > 0 ? normalized : "monitor:default"
}

export function sanitizePositions(value: unknown) {
	if (!isRecord(value))
		return {}
	const result: Record<string, number> = {}
	for (const [path, slot] of Object.entries(value)) {
		if (!path || typeof slot !== "number" || !Number.isFinite(slot))
			continue
		result[path] = Math.max(0, Math.floor(slot))
	}
	return result
}

export function sanitizeGrid(value: unknown): StoredGrid | null {
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

export function equalGrid(a: StoredGrid | null, b: StoredGrid | null) {
	if (a === b)
		return true
	if (!a || !b)
		return false
	return a.rows === b.rows
		&& a.columns === b.columns
		&& a.cellWidth === b.cellWidth
		&& a.cellHeight === b.cellHeight
}

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

export function positionsEqual(a: Record<string, number>, b: Record<string, number>) {
	const aKeys = Object.keys(a)
	const bKeys = Object.keys(b)

	if (aKeys.length !== bKeys.length)
		return false

	return aKeys.every(key => a[key] === b[key])
}

export function pickPositions(paths: Set<string>, positions: Record<string, number>) {
	const picked: Record<string, number> = {}
	for (const [path, slot] of Object.entries(positions)) {
		if (paths.has(path)) {
			picked[path] = slot
		}
	}
	return picked
}

export function remapSlotsAcrossColumns(
	positions: Record<string, number>,
	previousColumns: number,
	nextColumns: number,
	slotCount: number,
) {
	if (previousColumns <= 0 || nextColumns <= 0 || previousColumns === nextColumns)
		return positions

	const remapped: Record<string, number> = {}
	for (const [path, slot] of Object.entries(positions)) {
		const normalized = Math.max(0, Math.floor(slot))
		const row = Math.floor(normalized / previousColumns)
		const column = normalized % previousColumns
		const nextSlot = (row * nextColumns) + Math.min(column, nextColumns - 1)

		if (nextSlot >= 0 && nextSlot < slotCount) {
			remapped[path] = nextSlot
		}
	}

	return remapped
}

const GRID = {
	edgeMargins: {
		left: 12,
		right: 12,
		top: 12,
		bottom: 12,
	},
}

const ICON_METRICS_BY_SIZE: Record<DesktopIconSize, DesktopIconMetrics> = {
	small: { iconPx: 56, cellPx: 100, labelChars: 9 },
	medium: { iconPx: 64, cellPx: 110, labelChars: 10 },
	large: { iconPx: 80, cellPx: 140, labelChars: 11 },
	extralarge: { iconPx: 96, cellPx: 156, labelChars: 12 },
}

const ZERO_PADDING: WorkAreaPadding = {
	left: 0,
	right: 0,
	top: 0,
	bottom: 0,
}

export function getDesktopIconMetrics(size: string): DesktopIconMetrics {
	if (size === "medium")
		return ICON_METRICS_BY_SIZE.medium
	if (size === "large")
		return ICON_METRICS_BY_SIZE.large
	if (size === "extralarge")
		return ICON_METRICS_BY_SIZE.extralarge
	return ICON_METRICS_BY_SIZE.small
}

export function getGridMetrics(
	width: number,
	height: number,
	padding: WorkAreaPadding = ZERO_PADDING,
	cellSize = ICON_METRICS_BY_SIZE.small.cellPx,
): GridMetrics {
	const requestedEdgeLeft = Math.max(0, Math.floor(GRID.edgeMargins.left))
	const requestedEdgeRight = Math.max(0, Math.floor(GRID.edgeMargins.right))
	const edgeTop = Math.max(0, Math.floor(GRID.edgeMargins.top))
	const edgeBottom = Math.max(0, Math.floor(GRID.edgeMargins.bottom))

	const paddingLeft = Math.max(0, Math.floor(padding.left))
	const paddingRight = Math.max(0, Math.floor(padding.right))
	const paddingTop = Math.max(0, Math.floor(padding.top))
	const paddingBottom = Math.max(0, Math.floor(padding.bottom))

	const baseWidth = Math.max(1, Math.floor(width) - paddingLeft - paddingRight)
	const baseHeight = Math.max(1, Math.floor(height) - paddingTop - paddingBottom)

	const columns = Math.max(1, Math.floor(baseWidth / cellSize))
	const requestedSideMarginTotal = requestedEdgeLeft + requestedEdgeRight
	const maxSideMarginTotal = Math.max(0, baseWidth - (columns * cellSize))
	const sideMarginTotal = Math.min(requestedSideMarginTotal, maxSideMarginTotal)
	const leftRatio = requestedSideMarginTotal > 0
		? requestedEdgeLeft / requestedSideMarginTotal
		: 0.5
	const edgeLeft = Math.floor(sideMarginTotal * leftRatio)
	const edgeRight = sideMarginTotal - edgeLeft

	const safeWidth = Math.max(1, baseWidth - edgeLeft - edgeRight)
	const safeHeight = Math.max(1, baseHeight - edgeTop - edgeBottom)
	const targetRows = Math.max(1, Math.floor(safeHeight / cellSize))
	const widthCell = Math.max(1, Math.floor(safeWidth / columns))
	const heightCell = Math.max(1, Math.floor(safeHeight / targetRows))
	const squareCell = Math.max(1, Math.min(widthCell, heightCell))
	const rows = Math.max(1, Math.floor(safeHeight / squareCell))
	const cellWidth = widthCell
	const cellHeight = squareCell
	const usedWidth = cellWidth * columns
	const usedHeight = cellHeight * rows

	const freeWidth = Math.max(0, baseWidth - usedWidth)
	const gapLeft = Math.floor(freeWidth / 2)
	const gapRight = freeWidth - gapLeft
	const freeHeight = Math.max(0, safeHeight - usedHeight)

	return {
		cellWidth,
		cellHeight,
		rows,
		columns,
		offsetX: paddingLeft + gapLeft,
		offsetY: paddingTop + edgeTop,
		paddingRight: paddingRight + gapRight,
		paddingBottom: paddingBottom + edgeBottom + freeHeight,
	}
}

export function normalizePositions(
	fileList: DesktopFile[],
	current: Record<string, number>,
	slotCount: number,
	columns: number,
) {
	const nextPositions: Record<string, number> = { ...current }
	const validPaths = new Set(fileList.map(file => file.path))
	Object.keys(nextPositions).forEach(path => {
		if (!validPaths.has(path)) delete nextPositions[path]
	})
	const used = new Set<number>()
	const placed = new Set<string>()

	fileList.forEach(file => {
		const slot = nextPositions[file.path]
		if (slot != null && slot >= 0 && slot < slotCount && !used.has(slot)) {
			used.add(slot)
			placed.add(file.path)
		} else {
			delete nextPositions[file.path]
		}
	})

	const cols = Math.max(1, columns)
	const rows = Math.max(1, Math.floor(slotCount / cols))
	let cursor = 0
	const nextFreeSlot = () => {
		while (cursor < slotCount) {
			const slot = (cursor % rows) * cols + Math.floor(cursor / rows)
			cursor += 1
			if (!used.has(slot))
				return slot
		}
		return null
	}

	fileList.forEach(file => {
		if (placed.has(file.path)) return
		const slot = nextFreeSlot()
		if (slot != null) {
			nextPositions[file.path] = slot
			used.add(slot)
		}
	})

	return nextPositions
}

function normalizeSlots(
	fileList: DesktopFile[],
	current: Record<string, number>,
	slotCount: number,
	columns: number,
) {
	const nextPositions = normalizePositions(fileList, current, slotCount, columns)
	const slots: Array<DesktopFile | null> = Array.from({ length: slotCount }, () => null)

	for (const file of fileList) {
		const slot = nextPositions[file.path]
		if (slot != null && slot >= 0 && slot < slotCount && !slots[slot]) {
			slots[slot] = file
		}
	}

	return {
		slots,
		nextPositions,
	}
}

export function selectPathsByRectangle(
	fileList: DesktopFile[],
	positions: Record<string, number>,
	grid: GridMetrics,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
) {
	const minX = Math.min(x1, x2)
	const maxX = Math.max(x1, x2)
	const minY = Math.min(y1, y2)
	const maxY = Math.max(y1, y2)

	const selectedPaths: string[] = []
	const slotCount = grid.rows * grid.columns
	const { slots } = normalizeSlots(fileList, positions, slotCount, grid.columns)

	slots.forEach((file, index) => {
		if (!file)
			return

		const { x, y, width, height } = slotIndexToRect(index, grid)

		if (x + width >= minX && x <= maxX && y + height >= minY && y <= maxY) {
			selectedPaths.push(file.path)
		}
	})

	return selectedPaths
}

export function pointToSlotIndex(x: number, y: number, grid: GridMetrics) {
	const col = Math.max(0, Math.min(grid.columns - 1, Math.floor((x - grid.offsetX) / grid.cellWidth)))
	const row = Math.max(0, Math.min(grid.rows - 1, Math.floor((y - grid.offsetY) / grid.cellHeight)))
	return (row * grid.columns) + col
}

export function slotIndexToRect(slotIndex: number, grid: GridMetrics): SlotRect {
	const row = Math.floor(slotIndex / grid.columns)
	const col = slotIndex % grid.columns

	return {
		x: grid.offsetX + col * grid.cellWidth,
		y: grid.offsetY + row * grid.cellHeight,
		width: grid.cellWidth,
		height: grid.cellHeight,
	}
}

type DragOffset = {
	path: string
	row: number
	column: number
}

function getDragOffsets(paths: string[], anchorPath: string, positions: Record<string, number>, columns: number) {
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

function clamp(value: number, minimum: number, maximum: number) {
	if (minimum > maximum)
		return minimum

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

export function movePathsToSlot(layout: SlotLayout, files: DesktopFile[], move: SlotMove) {
	const normalized = normalizePositions(files, layout.positions, layout.slotCount, layout.columns)
	const dragged = Array.from(new Set(move.paths)).filter(path => normalized[path] != null)

	if (dragged.length === 0)
		return normalized

	if (dragged.length === 1) {
		const draggedPath = dragged[0]
		const sourceSlot = normalized[draggedPath]
		if (sourceSlot == null || sourceSlot === move.targetSlot)
			return normalized

		const next = { ...normalized }
		const occupiedPath = Object.entries(normalized).find(([path, slot]) =>
			path !== draggedPath && slot === move.targetSlot,
		)?.[0]

		next[draggedPath] = move.targetSlot
		if (occupiedPath)
			next[occupiedPath] = sourceSlot
		return next
	}

	const orderedDragged = [...dragged].sort((a, b) => (normalized[a] ?? 0) - (normalized[b] ?? 0))
	const anchorPath = orderedDragged.includes(move.anchorPath) ? move.anchorPath : orderedDragged[0]
	const fromSlot = normalized[anchorPath]

	if (fromSlot == null || fromSlot === move.targetSlot)
		return normalized

	const dragSet = new Set(orderedDragged)
	const occupiedByOthers = new Set(
		files
			.filter(file => !dragSet.has(file.path))
			.map(file => normalized[file.path])
			.filter((slot): slot is number => slot != null),
	)
	const offsets = getDragOffsets(orderedDragged, anchorPath, normalized, layout.columns)
	const anchor = getBoundedAnchor(move.targetSlot, layout.columns, layout.slotCount, offsets)
	const desiredSlots = new Map<string, number>()

	for (const offset of offsets) {
		const desiredSlot = ((anchor.row + offset.row) * layout.columns) + anchor.column + offset.column
		if (occupiedByOthers.has(desiredSlot))
			return normalized

		desiredSlots.set(offset.path, desiredSlot)
	}

	const next = { ...normalized }
	desiredSlots.forEach((slot, path) => {
		next[path] = slot
	})

	return next
}

export function movePathsToGrid(
	source: Pick<SlotLayout, "positions" | "columns">,
	target: SlotLayout,
	move: SlotMove,
) {
	const paths = Array.from(new Set(move.paths)).filter(Boolean)
	if (paths.length === 0)
		return { ...target.positions }

	const columns = Math.max(1, target.columns)
	const offsets = getDragOffsets(paths, move.anchorPath, source.positions, source.columns)
	const anchor = getBoundedAnchor(move.targetSlot, columns, target.slotCount, offsets)
	const taken = new Set(Object.values(target.positions))
	const next = { ...target.positions }

	function firstFreeSlot() {
		for (let slot = 0; slot < target.slotCount; slot += 1) {
			if (!taken.has(slot))
				return slot
		}
		return null
	}

	for (const offset of offsets) {
		let slot = ((anchor.row + offset.row) * columns) + anchor.column + offset.column
		if (slot < 0 || slot >= target.slotCount || taken.has(slot)) {
			const freeSlot = firstFreeSlot()
			if (freeSlot == null)
				continue
			slot = freeSlot
		}

		next[offset.path] = slot
		taken.add(slot)
	}

	return next
}
