// Converts monitor work areas into icon grid cells and selection areas.

import type { DesktopFile } from "./files"
import { normalizePositions } from "./placement"

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

const GRID = {
	edgeMargins: { left: 12, right: 12, top: 12, bottom: 12 },
}

const ICON_METRICS_BY_SIZE: Record<DesktopIconSize, DesktopIconMetrics> = {
	small: { iconPx: 56, cellPx: 100, labelChars: 9 },
	medium: { iconPx: 64, cellPx: 110, labelChars: 10 },
	large: { iconPx: 80, cellPx: 140, labelChars: 11 },
	extralarge: { iconPx: 96, cellPx: 156, labelChars: 12 },
}

const ZERO_PADDING: WorkAreaPadding = { left: 0, right: 0, top: 0, bottom: 0 }

export function getDesktopIconMetrics(size: string): DesktopIconMetrics {
	if (size === "medium") return ICON_METRICS_BY_SIZE.medium
	if (size === "large") return ICON_METRICS_BY_SIZE.large
	if (size === "extralarge") return ICON_METRICS_BY_SIZE.extralarge
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
	const leftRatio = requestedSideMarginTotal > 0 ? requestedEdgeLeft / requestedSideMarginTotal : 0.5
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

export function selectPathsByRectangle(
	fileList: DesktopFile[],
	positions: Record<string, number>,
	grid: GridMetrics,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): string[] {
	const minX = Math.min(x1, x2)
	const maxX = Math.max(x1, x2)
	const minY = Math.min(y1, y2)
	const maxY = Math.max(y1, y2)
	const slotCount = grid.rows * grid.columns
	const normalized = normalizePositions(fileList, positions, slotCount, grid.columns)
	const slots: Array<DesktopFile | null> = Array.from({ length: slotCount }, () => null)

	for (const file of fileList) {
		const slot = normalized[file.path]
		if (slot != null && slot >= 0 && slot < slotCount && !slots[slot])
			slots[slot] = file
	}

	const selectedPaths: string[] = []
	slots.forEach((file, index) => {
		if (!file) return
		const { x, y, width, height } = slotIndexToRect(index, grid)
		if (x + width >= minX && x <= maxX && y + height >= minY && y <= maxY)
			selectedPaths.push(file.path)
	})
	return selectedPaths
}

export function pointToSlotIndex(x: number, y: number, grid: GridMetrics): number {
	const column = Math.max(0, Math.min(grid.columns - 1, Math.floor((x - grid.offsetX) / grid.cellWidth)))
	const row = Math.max(0, Math.min(grid.rows - 1, Math.floor((y - grid.offsetY) / grid.cellHeight)))
	return (row * grid.columns) + column
}

export function slotIndexToRect(slotIndex: number, grid: GridMetrics): SlotRect {
	const row = Math.floor(slotIndex / grid.columns)
	const column = slotIndex % grid.columns
	return {
		x: grid.offsetX + column * grid.cellWidth,
		y: grid.offsetY + row * grid.cellHeight,
		width: grid.cellWidth,
		height: grid.cellHeight,
	}
}
