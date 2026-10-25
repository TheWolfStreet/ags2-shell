import assert from "node:assert/strict"
import test from "node:test"

import type { grid_metrics } from "../../widget/Desktop/grid_geometry.ts"
import {
	expand_grid_metrics,
	find_paths_intersecting_rectangle,
	get_grid_metrics,
	move_paths_to_grid,
	move_paths_to_slot,
	nearest_slot_index_for_point,
	reconcile_grid_positions,
	remap_slots_across_columns,
	tab_order_target,
} from "../../widget/Desktop/grid_geometry.ts"

test("reconciliation fills available slots without collisions after a resize", () => {
	for (let columns = 1; columns <= 12; columns++)
		for (let count = 0; count <= 60; count++) {
			const metrics = expand_grid_metrics(
				{ rows: 2, columns } as grid_metrics,
				count,
			)
			const capacity = metrics.rows * columns
			const files = Array.from({ length: count }, (_value, index) => ({
				path: `file-${index}`,
			}))
			const old = Object.fromEntries(
				files.map((file, index) => [file.path, index % 2 ? 0 : capacity + 1]),
			)
			const positions = reconcile_grid_positions(files, old, capacity, columns)
			assert.equal(Object.keys(positions).length, count)
			assert.equal(new Set(Object.values(positions)).size, count)
			assert.ok(
				Object.values(positions).every((slot) => slot >= 0 && slot < capacity),
			)
			assert.deepEqual(
				reconcile_grid_positions(files, positions, capacity, columns),
				positions,
			)
		}
})

test("cross-monitor group placement avoids occupied slots", () => {
	const positions = move_paths_to_grid(
		{ positions: { one: 0, two: 3 }, columns: 4 },
		{ positions: { existing: 0 }, columns: 2, slot_count: 4 },
		{ paths: ["one", "two"], anchor_path: "one", target_slot: 0 },
	)
	assert.equal(new Set(Object.values(positions)).size, 3)
	assert.ok(Object.values(positions).every((slot) => slot < 4))
})

test("single-icon moves swap with occupants without losing either position", () => {
	const files = [{ path: "one" }, { path: "two" }]
	const positions = move_paths_to_slot(
		{ positions: { one: 0, two: 1 }, columns: 2, slot_count: 2 },
		files,
		{ paths: ["one"], anchor_path: "one", target_slot: 1 },
	)
	assert.deepEqual(positions, { one: 1, two: 0 })
	const remapped = remap_slots_across_columns(positions, 2, 1, 2)
	assert.deepEqual(reconcile_grid_positions(files, remapped, 2, 1), {
		one: 0,
		two: 1,
	})
})

test("Tab walks icons in slot order, wraps, and Shift+Tab walks back", () => {
	const files = [{ path: "c" }, { path: "a" }, { path: "b" }, { path: "loose" }]
	const positions = { a: 0, b: 1, c: 5 }
	const step = (selected: string[], backwards = false) =>
		tab_order_target(files, positions, selected, backwards)
	assert.equal(step([]), "a")
	assert.equal(step([], true), "loose")
	assert.equal(step(["a"]), "b")
	assert.equal(step(["b"]), "c")
	assert.equal(step(["c"]), "loose")
	assert.equal(step(["loose"]), "a")
	assert.equal(step(["a"], true), "loose")
	assert.equal(step(["c", "a"]), "b")
	assert.equal(step(["gone"]), "a")
	assert.equal(tab_order_target([], {}, [], false), null)
})

test("grid metrics split free space around square cells and floor the padding", () => {
	assert.deepEqual(
		get_grid_metrics(
			1920,
			1080,
			{ left: 0, right: 0, top: 40, bottom: 0 },
			110,
			1,
		),
		{
			cell_width: 111,
			cell_height: 111,
			rows: 9,
			columns: 17,
			offset_x: 16,
			offset_y: 52,
			padding_right: 17,
			padding_bottom: 29,
		},
	)
	assert.deepEqual(
		get_grid_metrics(
			500,
			300,
			{ left: 10.7, right: -5, top: 3.2, bottom: 0 },
			100,
			2,
		),
		{
			cell_width: 110,
			cell_height: 110,
			rows: 2,
			columns: 4,
			offset_x: 35,
			offset_y: 27,
			padding_right: 25,
			padding_bottom: 53,
		},
	)
})

test("points outside the grid clamp to the nearest edge slot", () => {
	const metrics = get_grid_metrics(
		1920,
		1080,
		{ left: 0, right: 0, top: 40, bottom: 0 },
		110,
		1,
	)
	assert.equal(nearest_slot_index_for_point(-500, -500, metrics), 0)
	assert.equal(nearest_slot_index_for_point(99999, 99999, metrics), 152)
	assert.equal(nearest_slot_index_for_point(300, 200, metrics), 19)
})

test("rubber band selection returns intersecting icons in slot order", () => {
	const grid = {
		cell_width: 10,
		cell_height: 10,
		rows: 2,
		columns: 3,
		offset_x: 0,
		offset_y: 0,
		padding_right: 0,
		padding_bottom: 0,
	}
	const files = [{ path: "a" }, { path: "b" }, { path: "c" }]
	assert.deepEqual(
		find_paths_intersecting_rectangle(
			files,
			{ a: 5, b: 0, c: 1 },
			grid,
			25,
			15,
			12,
			3,
		),
		["c", "a"],
	)
})

test("reconciliation fills columns first and drops stale, duplicate and out-of-range slots", () => {
	const five = ["a", "b", "c", "d", "e"].map((path) => ({ path }))
	assert.deepEqual(reconcile_grid_positions(five, {}, 5, 2), {
		a: 0,
		b: 2,
		c: 1,
		d: 3,
	})
	const three = [{ path: "a" }, { path: "b" }, { path: "c" }]
	assert.deepEqual(
		reconcile_grid_positions(three, { a: 1, b: 1, c: 9, gone: 0 }, 6, 3),
		{ a: 1, b: 0, c: 3 },
	)
})

test("group moves keep their shape inside the grid and refuse to land on others", () => {
	const files = [{ path: "a" }, { path: "b" }, { path: "c" }]
	const layout = { positions: { a: 0, b: 1, c: 5 }, columns: 3, slot_count: 6 }
	const group = { paths: ["a", "b"], anchor_path: "a" }
	assert.deepEqual(
		move_paths_to_slot(layout, files, {
			...group,
			anchor_path: "b",
			target_slot: 5,
		}),
		{ a: 0, b: 1, c: 5 },
	)
	assert.deepEqual(
		move_paths_to_slot(layout, files, { ...group, target_slot: 3 }),
		{
			a: 3,
			b: 4,
			c: 5,
		},
	)
	assert.deepEqual(
		move_paths_to_slot({ ...layout, positions: { a: 0, b: 1, c: 4 } }, files, {
			...group,
			target_slot: 3,
		}),
		{ a: 0, b: 1, c: 4 },
	)
	assert.deepEqual(
		move_paths_to_slot(layout, files, {
			...group,
			anchor_path: "b",
			target_slot: 4,
		}),
		{ a: 3, b: 4, c: 5 },
	)
	assert.deepEqual(
		move_paths_to_slot(layout, files, {
			...group,
			anchor_path: "gone",
			target_slot: 4,
		}),
		{ a: 0, b: 1, c: 5 },
	)
})

test("cross-grid moves fall back to the first free slot and stop when the grid is full", () => {
	assert.deepEqual(
		move_paths_to_grid(
			{ positions: { a: 0, b: 1, c: 2 }, columns: 3 },
			{ positions: { x: 1, y: 3 }, columns: 2, slot_count: 4 },
			{ paths: ["a", "b", "c", "a", ""], anchor_path: "a", target_slot: 0 },
		),
		{ x: 1, y: 3, a: 0, b: 2 },
	)
	assert.deepEqual(
		move_paths_to_grid(
			{ positions: { a: 0 }, columns: 3 },
			{ positions: { x: 0 }, columns: 2, slot_count: 4 },
			{ paths: [], anchor_path: "a", target_slot: 0 },
		),
		{ x: 0 },
	)
	assert.deepEqual(
		move_paths_to_grid(
			{ positions: { a: 0 }, columns: 3 },
			{ positions: {}, columns: 2, slot_count: 6 },
			{ paths: ["a", ""], anchor_path: "a", target_slot: 1 },
		),
		{ a: 1 },
	)
})
