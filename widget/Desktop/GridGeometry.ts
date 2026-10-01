type grid_item = { path: string }

type desktop_icon_size = "small" | "medium" | "large" | "extralarge"

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

type work_area_padding = {
	left: number
	right: number
	top: number
	bottom: number
}

const grid = {
	edge_margins: { left: 12, right: 12, top: 12, bottom: 12 },
}

const icon_metrics_by_size: Record<desktop_icon_size, DesktopIconMetrics> = {
	small: { iconPx: 56, cellPx: 100, labelChars: 9 },
	medium: { iconPx: 64, cellPx: 110, labelChars: 10 },
	large: { iconPx: 80, cellPx: 140, labelChars: 11 },
	extralarge: { iconPx: 96, cellPx: 156, labelChars: 12 },
}

const zero_padding: work_area_padding = { left: 0, right: 0, top: 0, bottom: 0 }

export function get_desktop_icon_metrics(
	size: string,
	scale = 1,
): DesktopIconMetrics {
	let metrics = icon_metrics_by_size.small
	if (size === "medium") metrics = icon_metrics_by_size.medium
	else if (size === "large") metrics = icon_metrics_by_size.large
	else if (size === "extralarge") metrics = icon_metrics_by_size.extralarge
	return {
		...metrics,
		iconPx: Math.max(8, Math.round(metrics.iconPx * scale)),
		cellPx: Math.max(16, Math.round(metrics.cellPx * scale)),
	}
}

export function get_grid_metrics(
	width: number,
	height: number,
	padding: work_area_padding = zero_padding,
	cell_size = icon_metrics_by_size.small.cellPx,
	scale = 1,
): GridMetrics {
	const requested_edge_left = Math.max(
		0,
		Math.floor(grid.edge_margins.left * scale),
	)
	const requested_edge_right = Math.max(
		0,
		Math.floor(grid.edge_margins.right * scale),
	)
	const edge_top = Math.max(0, Math.floor(grid.edge_margins.top * scale))
	const edge_bottom = Math.max(0, Math.floor(grid.edge_margins.bottom * scale))
	const padding_left = Math.max(0, Math.floor(padding.left))
	const padding_right = Math.max(0, Math.floor(padding.right))
	const padding_top = Math.max(0, Math.floor(padding.top))
	const padding_bottom = Math.max(0, Math.floor(padding.bottom))
	const base_width = Math.max(1, Math.floor(width) - padding_left - padding_right)
	const base_height = Math.max(
		1,
		Math.floor(height) - padding_top - padding_bottom,
	)
	const columns = Math.max(1, Math.floor(base_width / cell_size))
	const requested_side_margin_total = requested_edge_left + requested_edge_right
	const max_side_margin_total = Math.max(0, base_width - columns * cell_size)
	const side_margin_total = Math.min(requested_side_margin_total, max_side_margin_total)
	const left_ratio =
		requested_side_margin_total > 0
			? requested_edge_left / requested_side_margin_total
			: 0.5
	const edge_left = Math.floor(side_margin_total * left_ratio)
	const edge_right = side_margin_total - edge_left
	const safe_width = Math.max(1, base_width - edge_left - edge_right)
	const safe_height = Math.max(1, base_height - edge_top - edge_bottom)
	const target_rows = Math.max(1, Math.floor(safe_height / cell_size))
	const width_cell = Math.max(1, Math.floor(safe_width / columns))
	const height_cell = Math.max(1, Math.floor(safe_height / target_rows))
	const square_cell = Math.max(1, Math.min(width_cell, height_cell))
	const rows = Math.max(1, Math.floor(safe_height / square_cell))
	const cell_width = width_cell
	const cell_height = square_cell
	const used_width = cell_width * columns
	const used_height = cell_height * rows
	const free_width = Math.max(0, base_width - used_width)
	const gap_left = Math.floor(free_width / 2)
	const gap_right = free_width - gap_left
	const free_height = Math.max(0, safe_height - used_height)

	return {
		cellWidth: cell_width,
		cellHeight: cell_height,
		rows,
		columns,
		offsetX: padding_left + gap_left,
		offsetY: padding_top + edge_top,
		paddingRight: padding_right + gap_right,
		paddingBottom: padding_bottom + edge_bottom + free_height,
	}
}

export function expand_grid_metrics(
	grid: GridMetrics,
	item_count: number,
): GridMetrics {
	const rows = Math.max(grid.rows, Math.ceil(item_count / grid.columns))
	return rows === grid.rows ? grid : { ...grid, rows }
}

export function find_paths_intersecting_rectangle(
	file_list: grid_item[],
	positions: Record<string, number>,
	grid: GridMetrics,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): string[] {
	const min_x = Math.min(x1, x2)
	const max_x = Math.max(x1, x2)
	const min_y = Math.min(y1, y2)
	const max_y = Math.max(y1, y2)
	const slot_count = grid.rows * grid.columns
	const normalized = reconcile_grid_positions(
		file_list,
		positions,
		slot_count,
		grid.columns,
	)
	const slots: Array<grid_item | null> = Array.from(
		{ length: slot_count },
		() => null,
	)

	for (const file of file_list) {
		const slot = normalized[file.path]
		if (slot != null && slot >= 0 && slot < slot_count && !slots[slot])
			slots[slot] = file
	}

	const selected_paths: string[] = []
	slots.forEach((file, index) => {
		if (!file) return
		const { x, y, width, height } = slot_index_to_rect(index, grid)
		if (x + width >= min_x && x <= max_x && y + height >= min_y && y <= max_y)
			selected_paths.push(file.path)
	})
	return selected_paths
}

export function nearest_slot_index_for_point(
	x: number,
	y: number,
	grid: GridMetrics,
): number {
	const column = Math.max(
		0,
		Math.min(grid.columns - 1, Math.floor((x - grid.offsetX) / grid.cellWidth)),
	)
	const row = Math.max(
		0,
		Math.min(grid.rows - 1, Math.floor((y - grid.offsetY) / grid.cellHeight)),
	)
	return row * grid.columns + column
}

export function slot_index_to_rect(
	slot_index: number,
	grid: GridMetrics,
): SlotRect {
	const row = Math.floor(slot_index / grid.columns)
	const column = slot_index % grid.columns
	return {
		x: grid.offsetX + column * grid.cellWidth,
		y: grid.offsetY + row * grid.cellHeight,
		width: grid.cellWidth,
		height: grid.cellHeight,
	}
}

type slot_layout = {
	positions: Record<string, number>
	columns: number
	slotCount: number
}

type slot_move = {
	paths: string[]
	anchorPath: string
	targetSlot: number
}

export function pick_positions(
	paths: Set<string>,
	positions: Record<string, number>,
): Record<string, number> {
	const picked: Record<string, number> = {}
	for (const [path, slot] of Object.entries(positions)) {
		if (paths.has(path)) picked[path] = slot
	}
	return picked
}

export function remap_slots_across_columns(
	positions: Record<string, number>,
	previous_columns: number,
	next_columns: number,
	slot_count: number,
): Record<string, number> {
	if (
		previous_columns <= 0 ||
		next_columns <= 0 ||
		previous_columns === next_columns
	)
		return positions

	const remapped: Record<string, number> = {}
	for (const [path, slot] of Object.entries(positions)) {
		const normalized = Math.max(0, Math.floor(slot))
		const row = Math.floor(normalized / previous_columns)
		const column = normalized % previous_columns
		const next_slot = row * next_columns + Math.min(column, next_columns - 1)
		if (next_slot >= 0 && next_slot < slot_count) remapped[path] = next_slot
	}
	return remapped
}

export function reconcile_grid_positions(
	file_list: grid_item[],
	current: Record<string, number>,
	slot_count: number,
	columns: number,
): Record<string, number> {
	const valid_paths = new Set(file_list.map((file) => file.path))
	const positions = { ...current }
	for (const path of Object.keys(positions))
		if (!valid_paths.has(path)) delete positions[path]

	const used_slots = new Set<number>()
	for (const file of file_list) {
		const slot = positions[file.path]
		if (slot != null && slot >= 0 && slot < slot_count && !used_slots.has(slot))
			used_slots.add(slot)
		else delete positions[file.path]
	}

	const column_count = Math.max(1, columns)
	const row_count = Math.max(1, Math.floor(slot_count / column_count))
	let cursor = 0

	for (const file of file_list) {
		if (positions[file.path] != null) continue

		let free_slot: number | null = null
		while (cursor < slot_count) {
			const slot =
				(cursor % row_count) * column_count + Math.floor(cursor / row_count)
			cursor += 1
			if (!used_slots.has(slot)) {
				free_slot = slot
				break
			}
		}

		if (free_slot == null) break
		positions[file.path] = free_slot
		used_slots.add(free_slot)
	}

	return positions
}

type drag_offset = { path: string; row: number; column: number }

function get_drag_offsets(
	paths: string[],
	anchor_path: string,
	positions: Record<string, number>,
	columns: number,
): drag_offset[] {
	const safe_columns = Math.max(1, columns)
	const anchor_slot = positions[anchor_path] ?? positions[paths[0]] ?? 0
	const anchor_row = Math.floor(anchor_slot / safe_columns)
	const anchor_column = anchor_slot % safe_columns
	return paths.map((path) => {
		const slot = positions[path] ?? anchor_slot
		return {
			path,
			row: Math.floor(slot / safe_columns) - anchor_row,
			column: (slot % safe_columns) - anchor_column,
		}
	})
}

function clamp(value: number, minimum: number, maximum: number): number {
	if (minimum > maximum) return minimum
	return Math.max(minimum, Math.min(maximum, value))
}

function get_bounded_anchor(
	target_slot: number,
	columns: number,
	slot_count: number,
	offsets: drag_offset[],
) {
	const safe_columns = Math.max(1, columns)
	const rows = Math.max(1, Math.floor(slot_count / safe_columns))
	const minimum_row = Math.min(...offsets.map(({ row }) => row))
	const maximum_row = Math.max(...offsets.map(({ row }) => row))
	const minimum_column = Math.min(...offsets.map(({ column }) => column))
	const maximum_column = Math.max(...offsets.map(({ column }) => column))
	return {
		row: clamp(
			Math.floor(target_slot / safe_columns),
			-minimum_row,
			rows - 1 - maximum_row,
		),
		column: clamp(
			target_slot % safe_columns,
			-minimum_column,
			safe_columns - 1 - maximum_column,
		),
	}
}

export function move_paths_to_slot(
	layout: slot_layout,
	files: grid_item[],
	move: slot_move,
): Record<string, number> {
	const normalized = reconcile_grid_positions(
		files,
		layout.positions,
		layout.slotCount,
		layout.columns,
	)
	const dragged = Array.from(new Set(move.paths)).filter(
		(path) => normalized[path] != null,
	)
	if (dragged.length === 0) return normalized

	if (dragged.length === 1) {
		const dragged_path = dragged[0]
		const source_slot = normalized[dragged_path]
		if (source_slot == null || source_slot === move.targetSlot) return normalized
		const next = { ...normalized }
		const occupied_path = Object.entries(normalized).find(
			([path, slot]) => path !== dragged_path && slot === move.targetSlot,
		)?.[0]
		next[dragged_path] = move.targetSlot
		if (occupied_path) next[occupied_path] = source_slot
		return next
	}

	const ordered_dragged = [...dragged].sort(
		(a, b) => (normalized[a] ?? 0) - (normalized[b] ?? 0),
	)
	const anchor_path = ordered_dragged.includes(move.anchorPath)
		? move.anchorPath
		: ordered_dragged[0]
	const from_slot = normalized[anchor_path]
	if (from_slot == null || from_slot === move.targetSlot) return normalized
	const dragged_paths = new Set(ordered_dragged)
	const occupied_by_others = new Set(
		files
			.filter((file) => !dragged_paths.has(file.path))
			.map((file) => normalized[file.path])
			.filter((slot): slot is number => slot != null),
	)
	const offsets = get_drag_offsets(
		ordered_dragged,
		anchor_path,
		normalized,
		layout.columns,
	)
	const anchor = get_bounded_anchor(
		move.targetSlot,
		layout.columns,
		layout.slotCount,
		offsets,
	)
	const desired_slots = new Map<string, number>()
	for (const offset of offsets) {
		const desired_slot =
			(anchor.row + offset.row) * layout.columns + anchor.column + offset.column
		if (occupied_by_others.has(desired_slot)) return normalized
		desired_slots.set(offset.path, desired_slot)
	}
	const next = { ...normalized }
	desired_slots.forEach((slot, path) => {
		next[path] = slot
	})
	return next
}

export function move_paths_to_grid(
	source: Pick<slot_layout, "positions" | "columns">,
	target: slot_layout,
	move: slot_move,
): Record<string, number> {
	const paths = [...new Set(move.paths)].filter(Boolean)
	const positions = { ...target.positions }
	if (paths.length === 0) return positions

	const columns = Math.max(1, target.columns)
	const offsets = get_drag_offsets(
		paths,
		move.anchorPath,
		source.positions,
		source.columns,
	)
	const anchor = get_bounded_anchor(
		move.targetSlot,
		columns,
		target.slotCount,
		offsets,
	)
	const used_slots = new Set(Object.values(target.positions))
	let free_slot_cursor = 0

	for (const offset of offsets) {
		let slot =
			(anchor.row + offset.row) * columns + anchor.column + offset.column

		if (slot < 0 || slot >= target.slotCount || used_slots.has(slot)) {
			while (free_slot_cursor < target.slotCount && used_slots.has(free_slot_cursor))
				free_slot_cursor += 1
			if (free_slot_cursor >= target.slotCount) break
			slot = free_slot_cursor
		}

		positions[offset.path] = slot
		used_slots.add(slot)
	}

	return positions
}
