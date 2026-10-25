import type options from "$shell/options"

type grid_item = { path: string }

type desktop_icon_size = ReturnType<typeof options.desktop.iconSize.peek>

export type desktop_icon_metrics = {
	icon_px: number
	cell_px: number
	label_chars: number
}

export type grid_metrics = {
	cell_width: number
	cell_height: number
	rows: number
	columns: number
	offset_x: number
	offset_y: number
	padding_right: number
	padding_bottom: number
}

export type slot_rect = {
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

const edge_margins = { left: 12, right: 12, top: 12, bottom: 12 }

const icon_metrics_by_size: Record<desktop_icon_size, desktop_icon_metrics> = {
	small: { icon_px: 56, cell_px: 100, label_chars: 9 },
	medium: { icon_px: 64, cell_px: 110, label_chars: 10 },
	large: { icon_px: 80, cell_px: 140, label_chars: 11 },
	extralarge: { icon_px: 96, cell_px: 156, label_chars: 12 },
}

export function get_desktop_icon_metrics(
	size: desktop_icon_size,
	scale = 1,
): desktop_icon_metrics {
	const metrics = icon_metrics_by_size[size]
	return {
		...metrics,
		icon_px: Math.max(8, Math.round(metrics.icon_px * scale)),
		cell_px: Math.max(16, Math.round(metrics.cell_px * scale)),
	}
}

function whole_pixels(value: number): number {
	return Math.max(0, Math.floor(value))
}

export function get_grid_metrics(
	width: number,
	height: number,
	padding: work_area_padding,
	cell_size: number,
	scale: number,
): grid_metrics {
	const requested_edge_left = whole_pixels(edge_margins.left * scale)
	const requested_edge_right = whole_pixels(edge_margins.right * scale)
	const edge_top = whole_pixels(edge_margins.top * scale)
	const edge_bottom = whole_pixels(edge_margins.bottom * scale)
	const padding_left = whole_pixels(padding.left)
	const padding_right = whole_pixels(padding.right)
	const padding_top = whole_pixels(padding.top)
	const padding_bottom = whole_pixels(padding.bottom)
	const base_width = Math.max(
		1,
		Math.floor(width) - padding_left - padding_right,
	)
	const base_height = Math.max(
		1,
		Math.floor(height) - padding_top - padding_bottom,
	)
	const columns = Math.max(1, Math.floor(base_width / cell_size))
	const requested_side_margin_total = requested_edge_left + requested_edge_right
	const max_side_margin_total = Math.max(0, base_width - columns * cell_size)
	const side_margin_total = Math.min(
		requested_side_margin_total,
		max_side_margin_total,
	)
	const left_ratio =
		requested_side_margin_total > 0
			? requested_edge_left / requested_side_margin_total
			: 0.5
	const edge_left = Math.floor(side_margin_total * left_ratio)
	const edge_right = side_margin_total - edge_left
	const safe_width = Math.max(1, base_width - edge_left - edge_right)
	const safe_height = Math.max(1, base_height - edge_top - edge_bottom)
	const target_rows = Math.max(1, Math.floor(safe_height / cell_size))
	const cell_width = Math.max(1, Math.floor(safe_width / columns))
	const height_cell = Math.max(1, Math.floor(safe_height / target_rows))
	const cell_height = Math.max(1, Math.min(cell_width, height_cell))
	const rows = Math.max(1, Math.floor(safe_height / cell_height))
	const free_width = Math.max(0, base_width - cell_width * columns)
	const gap_left = Math.floor(free_width / 2)
	const gap_right = free_width - gap_left
	const free_height = Math.max(0, safe_height - cell_height * rows)

	return {
		cell_width,
		cell_height,
		rows,
		columns,
		offset_x: padding_left + gap_left,
		offset_y: padding_top + edge_top,
		padding_right: padding_right + gap_right,
		padding_bottom: padding_bottom + edge_bottom + free_height,
	}
}

export function expand_grid_metrics(
	grid: grid_metrics,
	item_count: number,
): grid_metrics {
	const rows = Math.max(grid.rows, Math.ceil(item_count / grid.columns))
	return rows === grid.rows ? grid : { ...grid, rows }
}

export function slot_count(grid: grid_metrics): number {
	return grid.rows * grid.columns
}

export function unique_paths(paths: string[]): string[] {
	return [...new Set(paths)].filter(Boolean)
}

export function find_paths_intersecting_rectangle(
	file_list: grid_item[],
	positions: Record<string, number>,
	grid: grid_metrics,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): string[] {
	const min_x = Math.min(x1, x2)
	const max_x = Math.max(x1, x2)
	const min_y = Math.min(y1, y2)
	const max_y = Math.max(y1, y2)
	const count = slot_count(grid)
	const normalized = reconcile_grid_positions(
		file_list,
		positions,
		count,
		grid.columns,
	)
	const occupants: Array<grid_item | null> = Array.from(
		{ length: count },
		() => null,
	)
	for (const file of file_list) {
		const slot = normalized[file.path]
		if (slot != null && slot >= 0 && slot < count && !occupants[slot])
			occupants[slot] = file
	}

	const selected_paths: string[] = []
	for (let slot = 0; slot < count; slot++) {
		const file = occupants[slot]
		if (!file) continue
		const { x, y, width, height } = slot_index_to_rect(slot, grid)
		if (x + width >= min_x && x <= max_x && y + height >= min_y && y <= max_y)
			selected_paths.push(file.path)
	}
	return selected_paths
}

export function tab_order_target(
	file_list: grid_item[],
	positions: Record<string, number>,
	selected: readonly string[],
	backwards: boolean,
): string | null {
	const order = file_list
		.map((file, index) => ({
			path: file.path,
			slot: positions[file.path] ?? Number.MAX_SAFE_INTEGER,
			index,
		}))
		.sort((a, b) => a.slot - b.slot || a.index - b.index)
		.map((entry) => entry.path)
	if (order.length === 0) return null
	const current = order.indexOf(selected[selected.length - 1] ?? "")
	if (current < 0) return backwards ? order[order.length - 1] : order[0]
	const step = backwards ? order.length - 1 : 1
	return order[(current + step) % order.length]
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value))
}

export function nearest_slot_index_for_point(
	x: number,
	y: number,
	grid: grid_metrics,
): number {
	const column = clamp(
		Math.floor((x - grid.offset_x) / grid.cell_width),
		0,
		grid.columns - 1,
	)
	const row = clamp(
		Math.floor((y - grid.offset_y) / grid.cell_height),
		0,
		grid.rows - 1,
	)
	return row * grid.columns + column
}

export function slot_index_to_rect(
	slot_index: number,
	grid: grid_metrics,
): slot_rect {
	const row = Math.floor(slot_index / grid.columns)
	const column = slot_index % grid.columns
	return {
		x: grid.offset_x + column * grid.cell_width,
		y: grid.offset_y + row * grid.cell_height,
		width: grid.cell_width,
		height: grid.cell_height,
	}
}

type slot_layout = {
	positions: Record<string, number>
	columns: number
	slot_count: number
}

export type slot_move = {
	paths: string[]
	anchor_path: string
	target_slot: number
}

export function pick_positions(
	paths: Set<string>,
	positions: Record<string, number>,
): Record<string, number> {
	const picked: Record<string, number> = {}
	for (const [path, slot] of Object.entries(positions))
		if (paths.has(path)) picked[path] = slot
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

function row_major_order(slot_count: number): number[] {
	return Array.from({ length: slot_count }, (_value, slot) => slot)
}

function column_major_order(slot_count: number, columns: number): number[] {
	const column_count = Math.max(1, columns)
	const row_count = Math.max(1, Math.floor(slot_count / column_count))
	return Array.from(
		{ length: slot_count },
		(_value, cursor) =>
			(cursor % row_count) * column_count + Math.floor(cursor / row_count),
	)
}

function is_open_slot(
	slot: number | undefined,
	used_slots: Set<number>,
	slot_count: number,
): slot is number {
	return slot != null && slot >= 0 && slot < slot_count && !used_slots.has(slot)
}

function fill_slots(
	wanted: [string, number | undefined][],
	occupied: Iterable<number>,
	order: number[],
): Record<string, number> {
	const used_slots = new Set(occupied)
	const placed: Record<string, number> = {}
	let cursor = 0
	for (const [path, desired] of wanted) {
		let slot = desired
		if (!is_open_slot(slot, used_slots, order.length)) {
			while (cursor < order.length && used_slots.has(order[cursor])) cursor += 1
			if (cursor >= order.length) break
			slot = order[cursor]
		}
		placed[path] = slot
		used_slots.add(slot)
	}
	return placed
}

export function place_in_free_slots(
	wanted: [string, number | undefined][],
	occupied: Iterable<number>,
	slot_count: number,
): Record<string, number> {
	return fill_slots(wanted, occupied, row_major_order(slot_count))
}

export function reconcile_grid_positions(
	file_list: grid_item[],
	current: Record<string, number>,
	slot_count: number,
	columns: number,
): Record<string, number> {
	const listed_paths = new Set(file_list.map((file) => file.path))
	const positions = { ...current }
	for (const path of Object.keys(positions))
		if (!listed_paths.has(path)) delete positions[path]

	const used_slots = new Set<number>()
	for (const file of file_list) {
		const slot = positions[file.path]
		if (is_open_slot(slot, used_slots, slot_count)) used_slots.add(slot)
		else delete positions[file.path]
	}

	const unplaced = [...listed_paths].filter((path) => positions[path] == null)
	const placed = fill_slots(
		unplaced.map((path) => [path, undefined]),
		used_slots,
		column_major_order(slot_count, columns),
	)
	return { ...positions, ...placed }
}

type drag_offset = { path: string; row: number; column: number }

type grid_cell = { row: number; column: number }

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

function get_bounded_anchor(
	target_slot: number,
	columns: number,
	slot_count: number,
	offsets: drag_offset[],
): grid_cell {
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

function offset_slot(
	anchor: grid_cell,
	offset: drag_offset,
	columns: number,
): number {
	return (anchor.row + offset.row) * columns + anchor.column + offset.column
}

function swap_into_slot(
	positions: Record<string, number>,
	path: string,
	target_slot: number,
): Record<string, number> {
	const source_slot = positions[path]
	const occupant = Object.keys(positions).find(
		(other) => other !== path && positions[other] === target_slot,
	)
	const next = { ...positions, [path]: target_slot }
	if (occupant) next[occupant] = source_slot
	return next
}

function shift_group_to_slot(
	positions: Record<string, number>,
	files: grid_item[],
	dragged: string[],
	layout: slot_layout,
	move: slot_move,
): Record<string, number> {
	const ordered = [...dragged].sort((a, b) => positions[a] - positions[b])
	const anchor_path = ordered.includes(move.anchor_path)
		? move.anchor_path
		: ordered[0]
	if (positions[anchor_path] === move.target_slot) return positions

	const moving = new Set(ordered)
	const occupied_by_others = new Set(
		files
			.filter((file) => !moving.has(file.path))
			.map((file) => positions[file.path])
			.filter((slot): slot is number => slot != null),
	)
	const offsets = get_drag_offsets(
		ordered,
		anchor_path,
		positions,
		layout.columns,
	)
	const anchor = get_bounded_anchor(
		move.target_slot,
		layout.columns,
		layout.slot_count,
		offsets,
	)
	const next = { ...positions }
	for (const offset of offsets) {
		const slot = offset_slot(anchor, offset, layout.columns)
		if (occupied_by_others.has(slot)) return positions
		next[offset.path] = slot
	}
	return next
}

export function move_paths_to_slot(
	layout: slot_layout,
	files: grid_item[],
	move: slot_move,
): Record<string, number> {
	const normalized = reconcile_grid_positions(
		files,
		layout.positions,
		layout.slot_count,
		layout.columns,
	)
	const dragged = [...new Set(move.paths)].filter(
		(path) => normalized[path] != null,
	)
	if (dragged.length === 0) return normalized
	if (dragged.length === 1)
		return swap_into_slot(normalized, dragged[0], move.target_slot)
	return shift_group_to_slot(normalized, files, dragged, layout, move)
}

export function move_paths_to_grid(
	source: Pick<slot_layout, "positions" | "columns">,
	target: slot_layout,
	move: slot_move,
): Record<string, number> {
	const paths = unique_paths(move.paths)
	if (paths.length === 0) return { ...target.positions }

	const columns = Math.max(1, target.columns)
	const offsets = get_drag_offsets(
		paths,
		move.anchor_path,
		source.positions,
		source.columns,
	)
	const anchor = get_bounded_anchor(
		move.target_slot,
		columns,
		target.slot_count,
		offsets,
	)
	const wanted = offsets.map((offset): [string, number] => [
		offset.path,
		offset_slot(anchor, offset, columns),
	])
	const placed = place_in_free_slots(
		wanted,
		Object.values(target.positions),
		target.slot_count,
	)
	return { ...target.positions, ...placed }
}
