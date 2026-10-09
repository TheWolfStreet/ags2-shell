import assert from "node:assert/strict"
import test from "node:test"

import {
	expand_grid_metrics,
	move_paths_to_grid,
	move_paths_to_slot,
	reconcile_grid_positions,
	remap_slots_across_columns,
} from "../../widget/Desktop/GridGeometry.ts"

test("reconciliation fills available slots without collisions after a resize", () => {
	for (let columns = 1; columns <= 12; columns++) {
		for (let count = 0; count <= 60; count++) {
			const metrics = expand_grid_metrics({ rows: 2, columns }, count)
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
	}
})

test("cross-monitor group placement avoids occupied slots", () => {
	const positions = move_paths_to_grid(
		{ positions: { one: 0, two: 3 }, columns: 4 },
		{ positions: { existing: 0 }, columns: 2, slotCount: 4 },
		{ paths: ["one", "two"], anchorPath: "one", targetSlot: 0 },
	)
	assert.equal(new Set(Object.values(positions)).size, 3)
	assert.ok(Object.values(positions).every((slot) => slot < 4))
})

test("single-icon moves swap with occupants without losing either position", () => {
	const files = [{ path: "one" }, { path: "two" }]
	const positions = move_paths_to_slot(
		{ positions: { one: 0, two: 1 }, columns: 2, slotCount: 2 },
		files,
		{ paths: ["one"], anchorPath: "one", targetSlot: 1 },
	)
	assert.deepEqual(positions, { one: 1, two: 0 })
	const remapped = remap_slots_across_columns(positions, 2, 1, 2)
	assert.deepEqual(reconcile_grid_positions(files, remapped, 2, 1), {
		one: 0,
		two: 1,
	})
})
