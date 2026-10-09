import app from "$lib/app"
import { createState } from "ags"
import { readFile } from "ags/file"
import { Gdk, Gtk } from "ags/gtk4"
import { idle } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import env from "$lib/env"
import { attempt, log_error, unwrap_or, type Result } from "$lib/result"
import { debounce } from "$lib/time"

import {
	clear_clipboard_file_payload,
	create_desktop_folder,
	create_desktop_launcher,
	create_desktop_text_file,
	DESKTOP_PATH,
	load_desktop_files,
	open_path,
	permanently_delete_files,
	read_clipboard_file_payload,
	rename_file,
	trash_files,
	transfer_desktop_files,
	write_clipboard_file_payload,
} from "./FileOperations"
import type {
	ClipboardFilePayload,
	DesktopFile,
	DesktopLauncherSpec,
	DesktopTransferResult,
} from "./FileOperations"
import {
	expand_grid_metrics,
	move_paths_to_grid,
	move_paths_to_slot,
	pick_positions,
	reconcile_grid_positions,
	remap_slots_across_columns,
} from "./GridGeometry"
import type { GridMetrics } from "./GridGeometry"

const cache_file = `${env.paths.cache.base}/desktop-layout.json`
const default_monitor = "monitor:default"

type desktop_placement = {
	monitor: string
	slot?: number
}

type desktop_layout = {
	placements: Record<string, desktop_placement>
	columns: Record<string, number>
}

export type DesktopGridData = {
	id: string
	metrics: GridMetrics | null
	files: DesktopFile[]
	positions: Record<string, number>
}

type path_entry = { path: string }

function is_record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalize_monitor_id(monitor_id: string): string {
	const normalized = monitor_id.trim().toLowerCase()
	return normalized || default_monitor
}

function sanitize_slot(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: 0
}

function sanitize_optional_slot(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: undefined
}

function sanitize_column_count(value: unknown): number | undefined {
	const columns = sanitize_slot(value)
	return columns > 0 ? columns : undefined
}

function decode_layout(value: unknown): desktop_layout {
	const layout: desktop_layout = { placements: {}, columns: {} }
	if (!is_record(value)) return layout

	if (is_record(value.placements)) {
		for (const [path, raw_placement] of Object.entries(value.placements)) {
			if (!path || !is_record(raw_placement)) continue
			const monitor = normalize_monitor_id(
				typeof raw_placement.monitor === "string" ? raw_placement.monitor : "",
			)
			const slot = sanitize_optional_slot(raw_placement.slot)
			layout.placements[path] = slot == null ? { monitor } : { monitor, slot }
		}
	}

	if (is_record(value.columns)) {
		for (const [raw_id, raw_columns] of Object.entries(value.columns)) {
			const columns = sanitize_column_count(raw_columns)
			if (columns) layout.columns[normalize_monitor_id(raw_id)] = columns
		}
	}
	return layout
}

function load_layout(): desktop_layout {
	if (!GLib.file_test(cache_file, GLib.FileTest.EXISTS))
		return decode_layout({})
	const result = attempt((): unknown =>
		JSON.parse(readFile(cache_file) || "{}"),
	)
	return decode_layout(
		unwrap_or(result, {}, "desktop.loadLayout: Failed to load desktop layout"),
	)
}

function placements_equal(
	a: Record<string, desktop_placement>,
	b: Record<string, desktop_placement>,
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

function positions_of(
	layout: desktop_layout,
	monitor_id: string,
): Record<string, number> {
	const id = normalize_monitor_id(monitor_id)
	const positions: Record<string, number> = {}
	for (const [path, placement] of Object.entries(layout.placements))
		if (placement.monitor === id && placement.slot != null)
			positions[path] = placement.slot
	return positions
}

function files_on_monitor<T extends path_entry>(
	layout: desktop_layout,
	files: T[],
	monitor_id: string,
): T[] {
	const id = normalize_monitor_id(monitor_id)
	return files.filter((file) => layout.placements[file.path]?.monitor === id)
}

function fallback_monitor(layout: desktop_layout): string {
	return (
		Object.keys(layout.columns)[0] ??
		Object.values(layout.placements)[0]?.monitor ??
		default_monitor
	)
}

function assign_paths(
	layout: desktop_layout,
	paths: string[],
	monitor_id: string,
): desktop_layout {
	const monitor = normalize_monitor_id(monitor_id)
	const placements = { ...layout.placements }
	for (const path of new Set(paths)) {
		if (!path) continue
		const current = placements[path]
		placements[path] =
			current?.monitor === monitor && current.slot != null
				? { monitor, slot: current.slot }
				: { monitor }
	}
	return placements_equal(layout.placements, placements)
		? layout
		: { ...layout, placements }
}

function set_positions(
	layout: desktop_layout,
	monitor_id: string,
	positions: Record<string, number>,
): desktop_layout {
	const monitor = normalize_monitor_id(monitor_id)
	const placements = { ...layout.placements }
	for (const [path, placement] of Object.entries(placements)) {
		if (placement.monitor !== monitor) continue
		placements[path] =
			path in positions
				? { monitor, slot: sanitize_slot(positions[path]) }
				: { monitor }
	}
	return placements_equal(layout.placements, placements)
		? layout
		: { ...layout, placements }
}

function set_column_count(
	layout: desktop_layout,
	monitor_id: string,
	columns: number,
): desktop_layout {
	const id = normalize_monitor_id(monitor_id)
	if (layout.columns[id] === columns) return layout
	return { ...layout, columns: { ...layout.columns, [id]: columns } }
}

function sync_paths(
	layout: desktop_layout,
	files: path_entry[],
	fallback_monitor_id: string,
): desktop_layout {
	const fallback = normalize_monitor_id(fallback_monitor_id)
	const valid_paths = new Set(files.map((file) => file.path))
	const placements: Record<string, desktop_placement> = {}
	for (const [path, placement] of Object.entries(layout.placements)) {
		if (!valid_paths.has(path)) continue
		const monitor =
			placement.monitor === default_monitor && fallback !== default_monitor
				? fallback
				: normalize_monitor_id(placement.monitor)
		placements[path] =
			placement.slot == null
				? { monitor }
				: { monitor, slot: sanitize_slot(placement.slot) }
	}
	for (const file of files)
		if (!placements[file.path]) placements[file.path] = { monitor: fallback }
	return placements_equal(layout.placements, placements)
		? layout
		: { ...layout, placements }
}

function rename_placement(
	layout: desktop_layout,
	old_path: string,
	new_path: string,
): desktop_layout {
	const placement = layout.placements[old_path]
	if (!placement || !old_path || !new_path || old_path === new_path)
		return layout
	const placements = { ...layout.placements, [new_path]: placement }
	delete placements[old_path]
	return { ...layout, placements }
}

const [desktop_files, set_desktop_files] = createState<DesktopFile[]>([])
const [desktop_layout, set_desktop_layout] = createState(load_layout())
const [grid_metrics, set_grid_metrics] = createState<
	Record<string, GridMetrics>
>({})
const [connected_monitors, set_connected_monitors] = createState<Set<string>>(
	new Set(),
)
const [primary_monitor, set_primary_monitor] = createState("")
const [desktop_clipboard, update_desktop_clipboard] =
	createState<ClipboardFilePayload | null>(null)
export { desktop_clipboard }
const clipboard = Gdk.Display.get_default()?.get_clipboard()
const clipboard_handler = clipboard?.connect("changed", () => {
	if (!clipboard.is_local()) update_desktop_clipboard(null)
})

const save_layout = debounce(500, () => {
	const result = attempt(() => {
		if (
			!GLib.file_set_contents(
				cache_file,
				JSON.stringify(desktop_layout.peek(), null, 2),
			)
		)
			throw new Error("Layout write returned false")
	})
	log_error(result, "desktop.save: Failed to save desktop layout")
})

function update_layout(next: desktop_layout): void {
	if (next === desktop_layout.peek()) return
	set_desktop_layout(next)
	save_layout.call()
}

function normalize_owned_positions(
	layout: desktop_layout,
	id: string,
	files: DesktopFile[],
	metrics: GridMetrics,
): desktop_layout {
	const owned = files_on_monitor(layout, files, id)
	const expanded_metrics = expand_grid_metrics(metrics, owned.length)
	const positions = reconcile_grid_positions(
		owned,
		positions_of(layout, id),
		expanded_metrics.rows * expanded_metrics.columns,
		expanded_metrics.columns,
	)
	return set_positions(layout, id, positions)
}

function normalize_known_positions(
	layout: desktop_layout,
	files: DesktopFile[],
): desktop_layout {
	let next = layout
	for (const [id, metrics] of Object.entries(grid_metrics.peek())) {
		const previous_columns = next.columns[id]
		if (previous_columns && previous_columns !== metrics.columns) {
			const owned = files_on_monitor(next, files, id)
			const expanded = expand_grid_metrics(metrics, owned.length)
			const remapped = remap_slots_across_columns(
				positions_of(next, id),
				previous_columns,
				metrics.columns,
				expanded.rows * expanded.columns,
			)
			next = set_positions(next, id, remapped)
		}
		next = set_column_count(next, id, metrics.columns)
		next = normalize_owned_positions(next, id, files, metrics)
	}
	return next
}

let reload_sequence = 0
let has_loaded_files = false
async function reload_desktop_files(
	preferred_monitor_id?: string,
): Promise<void> {
	const sequence = ++reload_sequence
	const result = await load_desktop_files()
	if (sequence !== reload_sequence) return
	if (
		!log_error(result, "desktop.loadDesktopFiles: Failed to load desktop files")
	)
		return
	const files = result.value
	const current = desktop_layout.peek()
	const preferred =
		preferred_monitor_id?.trim() ||
		primary_monitor.peek() ||
		fallback_monitor(current)
	const next = normalize_known_positions(
		sync_paths(current, files, preferred),
		files,
	)
	has_loaded_files = true
	update_layout(next)
	set_desktop_files(files)
	const valid = new Set(files.map((file) => file.path))
	set_selected(selected.peek().filter((path) => valid.has(path)))
	if (pressed.peek() && !valid.has(pressed.peek()!)) set_pressed(null)
	if (rename_path.peek() && !valid.has(rename_path.peek()!))
		set_rename_path(null)
}

const refresh_desktop_files = debounce(120, reload_desktop_files)
let desktop_directory_monitor: Gio.FileMonitor | null = null
let desktop_parent_monitor: Gio.FileMonitor | null = null
let active_transfers = 0

function begin_desktop_transfer(): void {
	active_transfers += 1
	refresh_desktop_files.cancel()
}

async function finish_desktop_transfer(
	created_paths: string[],
	monitor_id: string,
): Promise<void> {
	if (created_paths.length > 0)
		update_layout(
			assign_paths(desktop_layout.peek(), created_paths, monitor_id),
		)
	active_transfers = Math.max(0, active_transfers - 1)
	if (active_transfers === 0) await reload_desktop_files()
}

function watch_desktop_directory(): void {
	if (desktop_directory_monitor) return
	if (!Gio.File.new_for_path(DESKTOP_PATH).query_exists(null)) {
		if (desktop_parent_monitor) return
		const direct_parent = Gio.File.new_for_path(DESKTOP_PATH).get_parent()
		let parent = direct_parent
		while (parent && !parent.query_exists(null)) parent = parent.get_parent()
		if (!parent) return
		const parent_result = attempt(() => {
			desktop_parent_monitor = parent.monitor_directory(
				Gio.FileMonitorFlags.NONE,
				null,
			)
			desktop_parent_monitor.connect("changed", () => {
				const directory_exists =
					Gio.File.new_for_path(DESKTOP_PATH).query_exists(null)
				if (
					!directory_exists &&
					(!direct_parent?.query_exists(null) || parent.equal(direct_parent))
				)
					return
				desktop_parent_monitor?.cancel()
				desktop_parent_monitor = null
				watch_desktop_directory()
				void reload_desktop_files()
			})
		})
		log_error(
			parent_result,
			"desktop.watchDesktopDir: Failed to watch desktop parent",
		)
		return
	}
	const result = attempt(() => {
		const directory = Gio.File.new_for_path(DESKTOP_PATH)
		desktop_directory_monitor = directory.monitor_directory(
			Gio.FileMonitorFlags.WATCH_MOVES,
			null,
		)
		desktop_directory_monitor.connect("changed", () => {
			if (!directory.query_exists(null)) {
				desktop_directory_monitor?.cancel()
				desktop_directory_monitor = null
				watch_desktop_directory()
				return
			}
			if (active_transfers === 0) refresh_desktop_files.call()
		})
	})
	log_error(
		result,
		"desktop.watchDesktopDir: Failed to watch desktop directory",
	)
}

export function desktop_file_by_path(path: string): DesktopFile | undefined {
	return desktop_files().find((file) => file.path === path)
}

export function get_desktop_grid(monitor_id: string): DesktopGridData {
	const id = normalize_monitor_id(monitor_id)
	const layout = desktop_layout()
	const files = desktop_files()
	const owned_files = files_on_monitor(layout, files, id)
	const saved_positions = positions_of(layout, id)
	const base_metrics = grid_metrics()[id]

	if (!base_metrics)
		return { id, metrics: null, files: owned_files, positions: saved_positions }

	const projected_files: DesktopFile[] = []
	if (primary_monitor() === id) {
		const connected = connected_monitors()
		for (const file of files) {
			const owner = layout.placements[file.path]?.monitor
			if (owner && owner !== id && !connected.has(owner))
				projected_files.push(file)
		}
	}

	const metrics = expand_grid_metrics(
		base_metrics,
		owned_files.length + projected_files.length,
	)
	if (!has_loaded_files)
		return { id, metrics, files: owned_files, positions: saved_positions }
	const owned_positions = reconcile_grid_positions(
		owned_files,
		saved_positions,
		metrics.rows * metrics.columns,
		metrics.columns,
	)

	if (projected_files.length === 0)
		return { id, metrics, files: owned_files, positions: owned_positions }

	projected_files.sort((left, right) => {
		const left_slot =
			layout.placements[left.path]?.slot ?? Number.MAX_SAFE_INTEGER
		const right_slot =
			layout.placements[right.path]?.slot ?? Number.MAX_SAFE_INTEGER
		return left_slot === right_slot
			? left.name.localeCompare(right.name)
			: left_slot - right_slot
	})

	const visible_files = [...owned_files]
	const visible_positions = { ...owned_positions }
	const used_slots = new Set(Object.values(owned_positions))
	const slot_count = metrics.rows * metrics.columns
	let next_free_slot = 0

	for (const file of projected_files) {
		const saved_slot = layout.placements[file.path]?.slot
		let slot = saved_slot

		if (slot == null || slot >= slot_count || used_slots.has(slot)) {
			while (next_free_slot < slot_count && used_slots.has(next_free_slot))
				next_free_slot += 1
			if (next_free_slot >= slot_count) break
			slot = next_free_slot
		}

		used_slots.add(slot)
		visible_files.push(file)
		visible_positions[file.path] = slot
	}

	return { id, metrics, files: visible_files, positions: visible_positions }
}

export function resize_desktop_grid(
	monitor_id: string,
	metrics: GridMetrics,
): void {
	const id = normalize_monitor_id(monitor_id)
	if (!has_loaded_files) {
		set_grid_metrics({ ...grid_metrics.peek(), [id]: metrics })
		return
	}
	let layout = desktop_layout.peek()
	const previous_columns = layout.columns[id]
	if (previous_columns && previous_columns !== metrics.columns) {
		const owned = files_on_monitor(layout, desktop_files.peek(), id)
		const expanded_metrics = expand_grid_metrics(metrics, owned.length)
		const remapped = remap_slots_across_columns(
			positions_of(layout, id),
			previous_columns,
			metrics.columns,
			expanded_metrics.rows * expanded_metrics.columns,
		)
		layout = set_positions(layout, id, remapped)
	}
	layout = set_column_count(layout, id, metrics.columns)
	set_grid_metrics({ ...grid_metrics.peek(), [id]: metrics })
	layout = normalize_owned_positions(layout, id, desktop_files.peek(), metrics)
	update_layout(layout)
}

export function set_desktop_monitors(ids: string[], primary_id: string): void {
	set_connected_monitors(new Set(ids.map(normalize_monitor_id)))
	set_primary_monitor(normalize_monitor_id(primary_id))
}

export function monitor_of_desktop_path(path: string): string | null {
	return path ? (desktop_layout.peek().placements[path]?.monitor ?? null) : null
}

export function move_desktop_files(opts: {
	to: string
	paths: string[]
	slot: number
	anchor?: string
}): void {
	const moving_paths = [...new Set(opts.paths)].filter(Boolean)
	if (moving_paths.length === 0) return

	const target_id = normalize_monitor_id(opts.to)
	const target = get_desktop_grid(target_id)
	if (!target.metrics) return

	const layout = desktop_layout.peek()
	const anchor_path = opts.anchor ?? moving_paths[0]
	const source_id = normalize_monitor_id(
		layout.placements[anchor_path]?.monitor ??
			layout.placements[moving_paths[0]]?.monitor ??
			target_id,
	)
	const crossing_monitors = source_id !== target_id

	let metrics = target.metrics
	if (crossing_monitors) {
		const visible_target_paths = new Set(target.files.map((file) => file.path))
		const incoming_count = moving_paths.filter(
			(path) => !visible_target_paths.has(path),
		).length
		metrics = expand_grid_metrics(metrics, target.files.length + incoming_count)
	}

	const target_grid = {
		positions: { ...target.positions },
		columns: metrics.columns,
		slotCount: metrics.rows * metrics.columns,
	}
	let moved_positions: Record<string, number>

	if (crossing_monitors) {
		for (const path of moving_paths) delete target_grid.positions[path]
		moved_positions = move_paths_to_grid(
			{
				positions: positions_of(layout, source_id),
				columns: layout.columns[source_id] ?? metrics.columns,
			},
			target_grid,
			{ paths: moving_paths, anchorPath: anchor_path, targetSlot: opts.slot },
		)
	} else {
		moved_positions = move_paths_to_slot(target_grid, target.files, {
			paths: moving_paths,
			anchorPath: anchor_path,
			targetSlot: opts.slot,
		})
	}

	const reassigned_layout = assign_paths(layout, moving_paths, target_id)
	const owned_paths = new Set(
		files_on_monitor(reassigned_layout, desktop_files.peek(), target_id).map(
			(file) => file.path,
		),
	)
	const owned_positions = pick_positions(owned_paths, moved_positions)
	update_layout(set_positions(reassigned_layout, target_id, owned_positions))
}

export function open_desktop_files(paths: string[]): void {
	for (const path of paths) {
		if (!path) continue
		log_error(open_path(path), "desktop.open: Failed to open desktop file")
	}
}

function set_desktop_clipboard(
	operation: "copy" | "cut",
	paths: string[],
): void {
	const files = [...new Set(paths)].filter(Boolean)
	if (files.length === 0) return
	void write_clipboard_file_payload(operation, files).then((result) => {
		if (
			log_error(
				result,
				"desktop.setClipboardFiles: Failed to set desktop clipboard",
			)
		)
			update_desktop_clipboard({ operation, files })
	})
}

export function copy_desktop_files(paths: string[]): void {
	set_desktop_clipboard("copy", paths)
}

export function cut_desktop_files(paths: string[]): void {
	set_desktop_clipboard("cut", paths)
}

export async function cancel_desktop_cut(): Promise<void> {
	const original_content = clipboard?.get_content()
	const current = await read_clipboard_file_payload()
	const local = desktop_clipboard.peek()
	if (
		current?.operation === "cut" &&
		local?.operation === "cut" &&
		clipboard?.is_local() &&
		original_content === clipboard.get_content() &&
		current.files.join("\0") === local.files.join("\0")
	) {
		const result = await clear_clipboard_file_payload()
		log_error(
			result,
			"desktop.clearClipboardFiles: Failed to clear desktop clipboard",
		)
	}
	if (local?.operation === "cut") update_desktop_clipboard(null)
}

export async function paste_desktop_files(monitor_id: string): Promise<void> {
	const original_content = clipboard?.get_content()
	const payload = await read_clipboard_file_payload()
	if (!payload?.files.length) return

	const monitor = monitor_id.trim() || fallback_monitor(desktop_layout.peek())
	let visible_paths: string[] = []
	begin_desktop_transfer()

	try {
		const result = await transfer_desktop_files({
			paths: payload.files,
			operation: payload.operation === "cut" ? "move" : "copy",
		})
		visible_paths = [
			...result.createdPaths,
			...result.failures.flatMap((failure) =>
				failure.destination ? [failure.destination] : [],
			),
		]

		if (result.failures.length > 0)
			console.error(
				"desktop.pasteFiles: Failed to paste some desktop files",
				result.failures,
			)
		else if (payload.operation === "cut") {
			if (
				clipboard?.is_local() &&
				original_content === clipboard.get_content() &&
				desktop_clipboard.peek()?.files.join("\0") === payload.files.join("\0")
			) {
				const cleared = await clear_clipboard_file_payload()
				log_error(
					cleared,
					"desktop.pasteFiles: Failed to clear moved clipboard files",
				)
			}
			update_desktop_clipboard(null)
		}
	} finally {
		await finish_desktop_transfer(visible_paths, monitor)
	}
}

export async function import_files_to_desktop(opts: {
	paths: string[]
	to: string
	operation: "copy" | "move"
}): Promise<DesktopTransferResult> {
	let visible_paths: string[] = []
	begin_desktop_transfer()
	try {
		const result = await transfer_desktop_files({
			paths: opts.paths,
			operation: opts.operation,
		})
		visible_paths = [
			...result.createdPaths,
			...result.failures.flatMap((failure) =>
				failure.destination ? [failure.destination] : [],
			),
		]
		if (result.failures.length > 0)
			console.error(
				"desktop.importFiles: Failed to import some desktop files",
				result.failures,
			)
		return result
	} finally {
		await finish_desktop_transfer(visible_paths, opts.to)
	}
}

export async function remove_desktop_files(
	paths: string[],
	opts: { permanently?: boolean } = {},
): Promise<void> {
	if (paths.length === 0) return
	const result = opts.permanently
		? await permanently_delete_files(paths)
		: await trash_files(paths)
	if (result.failures.length)
		console.error("desktop.remove: Failed to remove files", result.failures)
	const removed = new Set(result.removedPaths)
	set_selected(selected.peek().filter((path) => !removed.has(path)))
	if (pressed.peek() && removed.has(pressed.peek()!)) set_pressed(null)
	if (rename_path.peek() && removed.has(rename_path.peek()!))
		set_rename_path(null)
	await reload_desktop_files()
}

function remember_created_path(path: string, monitor_id: string): string {
	update_layout(assign_paths(desktop_layout.peek(), [path], monitor_id))
	reload_desktop_files(monitor_id)
	return path
}

export type DesktopEntrySpec =
	| { kind: "folder" }
	| { kind: "file" }
	| ({ kind: "launcher" } & DesktopLauncherSpec)

export function create_desktop_entry(
	monitor_id: string,
	spec: DesktopEntrySpec,
): string | null {
	let result: Result<string>
	if (spec.kind === "folder") {
		result = create_desktop_folder()
	} else if (spec.kind === "file") {
		result = create_desktop_text_file()
	} else {
		result = create_desktop_launcher(spec)
	}
	if (
		!log_error(result, `desktop.create: Failed to create desktop ${spec.kind}`)
	)
		return null
	return remember_created_path(result.value, monitor_id)
}

function rename_desktop_file(target: string, name: string): string | null {
	if (!target || !name.trim()) return null
	const result = rename_file(target, name)
	if (!log_error(result, "desktop.rename: Failed to rename desktop file"))
		return null
	const path = result.value
	update_layout(rename_placement(desktop_layout.peek(), target, path))
	set_desktop_files(
		desktop_files.peek().map((file) => {
			if (file.path !== target) return file
			return {
				...file,
				path,
				name: path.split("/").pop() ?? file.name,
				displayName: path.toLowerCase().endsWith(".desktop")
					? file.displayName
					: undefined,
			}
		}),
	)
	return path
}

const [selected, set_selected] = createState<string[]>([])
const [pressed, set_pressed] = createState<string | null>(null)
const [rename_path, set_rename_path] = createState<string | null>(null)
const [rename_value, set_rename_value] = createState("")
const roots = new Set<Gtk.Widget>()

export const desktop_interaction = {
	selected,
	pressed,
	select: set_selected,
	press: set_pressed,
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
		path: rename_path,
		value: rename_value,
		set_value: set_rename_value,
		begin(path: string) {
			const name = path.split("/").pop() || ""
			if (rename_path.peek() === path) {
				set_rename_path(null)
				idle(() => {
					set_rename_value(name)
					set_rename_path(path)
				})
			} else {
				set_rename_value(name)
				set_rename_path(path)
			}
			set_selected([path])
		},
		commit() {
			const target = rename_path.peek()
			const name = rename_value.peek().trim()
			if (!target || !name || target.split("/").pop() === name) {
				set_rename_path(null)
				return
			}
			const path = rename_desktop_file(target, name)
			if (path) set_selected([path])
			set_rename_path(null)
		},
		cancel() {
			set_rename_path(null)
		},
	},
}

reload_desktop_files()
watch_desktop_directory()
app.connect("shutdown", () => {
	if (clipboard && clipboard_handler) clipboard.disconnect(clipboard_handler)
	desktop_parent_monitor?.cancel()
	desktop_parent_monitor = null
	desktop_directory_monitor?.cancel()
	desktop_directory_monitor = null
	refresh_desktop_files.cancel()
	if (save_layout.pending) save_layout.flush()
	save_layout.cancel()
})
