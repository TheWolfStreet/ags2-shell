import app from "$lib/app"
import { createState } from "ags"
import { readFile } from "ags/file"
import { Gdk, Gtk } from "ags/gtk4"
import { debounce, idle } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import env from "$lib/env"
import {
	attempt,
	err,
	log_error,
	ok,
	unwrap_or,
	type result,
} from "$lib/result"

import {
	clear_clipboard_file_payload,
	create_desktop_folder,
	create_desktop_launcher,
	create_desktop_text_file,
	delete_desktop_files,
	desktop_path,
	load_desktop_files,
	open_path,
	read_clipboard_file_payload,
	rename_file,
	transfer_desktop_files,
	write_clipboard_file_payload,
} from "./file_operations"
import type {
	clipboard_file_payload,
	desktop_file,
	desktop_launcher_spec,
	desktop_transfer_result,
} from "./file_operations"
import {
	expand_grid_metrics,
	move_paths_to_grid,
	move_paths_to_slot,
	pick_positions,
	place_in_free_slots,
	reconcile_grid_positions,
	remap_slots_across_columns,
	slot_count,
	unique_paths,
} from "./grid_geometry"
import type { grid_metrics, slot_move } from "./grid_geometry"
import { is_record } from "$lib/json"
import { base_name, is_launcher_path } from "$lib/text"

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

export type desktop_grid_data = {
	id: string
	metrics: grid_metrics | null
	files: desktop_file[]
	positions: Record<string, number>
}

type path_entry = { path: string }

function normalize_monitor_id(monitor_id: string): string {
	const normalized = monitor_id.trim().toLowerCase()
	return normalized || default_monitor
}

function sanitize_optional_slot(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: undefined
}

function sanitize_slot(value: unknown): number {
	return sanitize_optional_slot(value) ?? 0
}

function sanitize_column_count(value: unknown): number | undefined {
	const columns = sanitize_slot(value)
	return columns > 0 ? columns : undefined
}

function decode_layout(value: unknown): desktop_layout {
	const layout: desktop_layout = { placements: {}, columns: {} }
	if (!is_record(value)) return layout

	if (is_record(value.placements))
		for (const [path, raw_placement] of Object.entries(value.placements)) {
			if (!path || !is_record(raw_placement)) continue
			const monitor = normalize_monitor_id(
				typeof raw_placement.monitor === "string" ? raw_placement.monitor : "",
			)
			const slot = sanitize_optional_slot(raw_placement.slot)
			layout.placements[path] = slot == null ? { monitor } : { monitor, slot }
		}

	if (is_record(value.columns))
		for (const [raw_id, raw_columns] of Object.entries(value.columns)) {
			const columns = sanitize_column_count(raw_columns)
			if (columns) layout.columns[normalize_monitor_id(raw_id)] = columns
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
		unwrap_or(result, {}, "desktop.load_layout: Failed to load desktop layout"),
	)
}

function with_placements(
	layout: desktop_layout,
	placements: Record<string, desktop_placement>,
): desktop_layout {
	if (placements_equal(layout.placements, placements)) return layout
	return { ...layout, placements }
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
	for (const path of unique_paths(paths)) {
		const current = placements[path]
		placements[path] =
			current?.monitor === monitor && current.slot != null
				? { monitor, slot: current.slot }
				: { monitor }
	}
	return with_placements(layout, placements)
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
	return with_placements(layout, placements)
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
	return with_placements(layout, placements)
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

const [desktop_files, set_desktop_files] = createState<desktop_file[]>([])
const [desktop_layout, set_desktop_layout] = createState(load_layout())
const [grid_metrics, set_grid_metrics] = createState<
	Record<string, grid_metrics>
>({})
const [connected_monitors, set_connected_monitors] = createState<Set<string>>(
	new Set(),
)
const [primary_monitor, set_primary_monitor] = createState("")
const [desktop_clipboard, update_desktop_clipboard] =
	createState<clipboard_file_payload | null>(null)
export { desktop_clipboard }
const clipboard = Gdk.Display.get_default()?.get_clipboard()
const clipboard_handler = clipboard?.connect("changed", () => {
	if (!clipboard.is_local()) update_desktop_clipboard(null)
})

function write_layout(): result<void> {
	const written = attempt(() =>
		GLib.file_set_contents(
			cache_file,
			JSON.stringify(desktop_layout.peek(), null, 2),
		),
	)
	if (!written.ok) return written
	if (!written.value) return err(new Error("Layout write returned false"))
	return ok(undefined)
}

const save_layout = debounce(500, () => {
	log_error(write_layout(), "desktop.save: Failed to save desktop layout")
})

function update_layout(next: desktop_layout): void {
	if (next === desktop_layout.peek()) return
	set_desktop_layout(next)
	save_layout.call()
}

function remap_columns(
	layout: desktop_layout,
	id: string,
	files: desktop_file[],
	metrics: grid_metrics,
): desktop_layout {
	const previous_columns = layout.columns[id]
	if (!previous_columns || previous_columns === metrics.columns) return layout
	const owned = files_on_monitor(layout, files, id)
	const remapped = remap_slots_across_columns(
		positions_of(layout, id),
		previous_columns,
		metrics.columns,
		slot_count(expand_grid_metrics(metrics, owned.length)),
	)
	return set_positions(layout, id, remapped)
}

function apply_grid_metrics(
	layout: desktop_layout,
	id: string,
	files: desktop_file[],
	metrics: grid_metrics,
): desktop_layout {
	const remapped = set_column_count(
		remap_columns(layout, id, files, metrics),
		id,
		metrics.columns,
	)
	const owned = files_on_monitor(remapped, files, id)
	const expanded = expand_grid_metrics(metrics, owned.length)
	const positions = reconcile_grid_positions(
		owned,
		positions_of(remapped, id),
		slot_count(expanded),
		expanded.columns,
	)
	return set_positions(remapped, id, positions)
}

function normalize_known_positions(
	layout: desktop_layout,
	files: desktop_file[],
): desktop_layout {
	let next = layout
	for (const [id, metrics] of Object.entries(grid_metrics.peek()))
		next = apply_grid_metrics(next, id, files, metrics)
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
		!log_error(
			result,
			"desktop.load_desktop_files: Failed to load desktop files",
		)
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
	show_desktop_files(files)
}

function forget_paths(gone: (path: string) => boolean): void {
	set_selected(selected.peek().filter((path) => !gone(path)))
	const pressed_path = pressed.peek()
	if (pressed_path && gone(pressed_path)) set_pressed(null)
	const renamed_path = rename_path.peek()
	if (renamed_path && gone(renamed_path)) set_rename_path(null)
}

function show_desktop_files(files: desktop_file[]): void {
	set_desktop_files(files)
	const valid = new Set(files.map((file) => file.path))
	forget_paths((path) => !valid.has(path))
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

function nearest_existing(file: Gio.File | null): Gio.File | null {
	let current = file
	while (current && !current.query_exists(null)) current = current.get_parent()
	return current
}

function parent_watch_stale(
	watched: Gio.File,
	direct_parent: Gio.File | null,
): boolean {
	if (Gio.File.new_for_path(desktop_path).query_exists(null)) return true
	if (!direct_parent?.query_exists(null)) return false
	return !watched.equal(direct_parent)
}

function on_parent_changed(
	watched: Gio.File,
	direct_parent: Gio.File | null,
): void {
	if (!parent_watch_stale(watched, direct_parent)) return
	desktop_parent_monitor?.cancel()
	desktop_parent_monitor = null
	watch_desktop_directory()
	void reload_desktop_files()
}

function watch_desktop_parent(): void {
	const direct_parent = Gio.File.new_for_path(desktop_path).get_parent()
	const watched = nearest_existing(direct_parent)
	if (!watched) return
	const result = attempt(() => {
		desktop_parent_monitor = watched.monitor_directory(
			Gio.FileMonitorFlags.NONE,
			null,
		)
		desktop_parent_monitor.connect("changed", () =>
			on_parent_changed(watched, direct_parent),
		)
	})
	log_error(result, "desktop.watch_desktop_dir: Failed to watch desktop parent")
}

function on_desktop_changed(directory: Gio.File): void {
	if (directory.query_exists(null)) {
		if (active_transfers === 0) refresh_desktop_files.call()
		return
	}
	desktop_directory_monitor?.cancel()
	desktop_directory_monitor = null
	reload_sequence += 1
	refresh_desktop_files.cancel()
	show_desktop_files([])
	watch_desktop_directory()
}

function watch_desktop(directory: Gio.File): void {
	const result = attempt(() => {
		desktop_directory_monitor = directory.monitor_directory(
			Gio.FileMonitorFlags.WATCH_MOVES,
			null,
		)
		desktop_directory_monitor.connect("changed", () =>
			on_desktop_changed(directory),
		)
	})
	log_error(
		result,
		"desktop.watch_desktop_dir: Failed to watch desktop directory",
	)
}

function watch_desktop_directory(): void {
	if (desktop_directory_monitor) return
	const directory = Gio.File.new_for_path(desktop_path)
	if (directory.query_exists(null)) watch_desktop(directory)
	else if (!desktop_parent_monitor) watch_desktop_parent()
}

export function desktop_file_by_path(path: string): desktop_file | undefined {
	return desktop_files().find((file) => file.path === path)
}

function orphaned_files(
	layout: desktop_layout,
	files: desktop_file[],
	id: string,
): desktop_file[] {
	if (primary_monitor() !== id) return []
	const connected = connected_monitors()
	const orphans = files.filter((file) => {
		const owner = layout.placements[file.path]?.monitor
		if (!owner || owner === id) return false
		return !connected.has(owner)
	})
	const saved_slot = (file: desktop_file) =>
		layout.placements[file.path]?.slot ?? Number.MAX_SAFE_INTEGER
	return orphans.sort((left, right) => {
		const left_slot = saved_slot(left)
		const right_slot = saved_slot(right)
		if (left_slot === right_slot) return left.name.localeCompare(right.name)
		return left_slot - right_slot
	})
}

export function get_desktop_grid(monitor_id: string): desktop_grid_data {
	const id = normalize_monitor_id(monitor_id)
	const layout = desktop_layout()
	const files = desktop_files()
	const owned_files = files_on_monitor(layout, files, id)
	const saved_positions = positions_of(layout, id)
	const base_metrics = grid_metrics()[id]

	if (!base_metrics)
		return { id, metrics: null, files: owned_files, positions: saved_positions }

	const orphans = orphaned_files(layout, files, id)
	const metrics = expand_grid_metrics(
		base_metrics,
		owned_files.length + orphans.length,
	)
	if (!has_loaded_files)
		return { id, metrics, files: owned_files, positions: saved_positions }
	const owned_positions = reconcile_grid_positions(
		owned_files,
		saved_positions,
		slot_count(metrics),
		metrics.columns,
	)
	if (orphans.length === 0)
		return { id, metrics, files: owned_files, positions: owned_positions }

	const projected = place_in_free_slots(
		orphans.map((file) => [file.path, layout.placements[file.path]?.slot]),
		Object.values(owned_positions),
		slot_count(metrics),
	)
	return {
		id,
		metrics,
		files: [
			...owned_files,
			...orphans.filter((file) => file.path in projected),
		],
		positions: { ...owned_positions, ...projected },
	}
}

export function resize_desktop_grid(
	monitor_id: string,
	metrics: grid_metrics,
): void {
	const id = normalize_monitor_id(monitor_id)
	set_grid_metrics({ ...grid_metrics.peek(), [id]: metrics })
	if (!has_loaded_files) return
	update_layout(
		apply_grid_metrics(
			desktop_layout.peek(),
			id,
			desktop_files.peek(),
			metrics,
		),
	)
}

export function set_desktop_monitors(ids: string[], primary_id: string): void {
	set_connected_monitors(new Set(ids.map(normalize_monitor_id)))
	set_primary_monitor(normalize_monitor_id(primary_id))
}

export function monitor_of_desktop_path(path: string): string | null {
	return path ? (desktop_layout.peek().placements[path]?.monitor ?? null) : null
}

function move_within_grid(
	target: desktop_grid_data,
	metrics: grid_metrics,
	move: slot_move,
): Record<string, number> {
	return move_paths_to_slot(
		{
			positions: target.positions,
			columns: metrics.columns,
			slot_count: slot_count(metrics),
		},
		target.files,
		move,
	)
}

function move_across_grids(
	layout: desktop_layout,
	source_id: string,
	target: desktop_grid_data,
	metrics: grid_metrics,
	move: slot_move,
): Record<string, number> {
	const visible_paths = new Set(target.files.map((file) => file.path))
	const incoming = move.paths.filter((path) => !visible_paths.has(path))
	const expanded = expand_grid_metrics(
		metrics,
		target.files.length + incoming.length,
	)
	const positions = { ...target.positions }
	for (const path of move.paths) delete positions[path]
	return move_paths_to_grid(
		{
			positions: positions_of(layout, source_id),
			columns: layout.columns[source_id] ?? expanded.columns,
		},
		{
			positions,
			columns: expanded.columns,
			slot_count: slot_count(expanded),
		},
		move,
	)
}

export function move_desktop_files(opts: {
	to: string
	paths: string[]
	slot: number
	anchor?: string
}): void {
	const paths = unique_paths(opts.paths)
	if (paths.length === 0) return

	const target_id = normalize_monitor_id(opts.to)
	const target = get_desktop_grid(target_id)
	if (!target.metrics) return

	const layout = desktop_layout.peek()
	const move = {
		paths,
		anchor_path: opts.anchor ?? paths[0],
		target_slot: opts.slot,
	}
	const source_id = normalize_monitor_id(
		layout.placements[move.anchor_path]?.monitor ??
			layout.placements[paths[0]]?.monitor ??
			target_id,
	)
	const moved =
		source_id === target_id
			? move_within_grid(target, target.metrics, move)
			: move_across_grids(layout, source_id, target, target.metrics, move)

	const reassigned = assign_paths(layout, paths, target_id)
	const owned_paths = new Set(
		files_on_monitor(reassigned, desktop_files.peek(), target_id).map(
			(file) => file.path,
		),
	)
	update_layout(
		set_positions(reassigned, target_id, pick_positions(owned_paths, moved)),
	)
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
	const payload = { operation, paths: unique_paths(paths) }
	if (payload.paths.length === 0) return
	if (
		log_error(
			write_clipboard_file_payload(payload),
			"desktop.set_clipboard_files: Failed to set desktop clipboard",
		)
	)
		update_desktop_clipboard(payload)
}

export function copy_desktop_files(paths: string[]): void {
	set_desktop_clipboard("copy", paths)
}

export function cut_desktop_files(paths: string[]): void {
	set_desktop_clipboard("cut", paths)
}

function same_files(left: string[] | undefined, right: string[]): boolean {
	return left?.join("\0") === right.join("\0")
}

function clipboard_untouched(original_content: unknown): boolean {
	if (!clipboard?.is_local()) return false
	return original_content === clipboard.get_content()
}

export async function cancel_desktop_cut(): Promise<void> {
	const original_content = clipboard?.get_content()
	const current = await read_clipboard_file_payload()
	const local = desktop_clipboard.peek()
	if (
		current?.operation === "cut" &&
		local?.operation === "cut" &&
		clipboard_untouched(original_content) &&
		same_files(current.paths, local.paths)
	)
		log_error(
			clear_clipboard_file_payload(),
			"desktop.clear_clipboard_files: Failed to clear desktop clipboard",
		)
	if (local?.operation === "cut") update_desktop_clipboard(null)
}

export async function paste_desktop_files(monitor_id: string): Promise<void> {
	const original_content = clipboard?.get_content()
	const payload = await read_clipboard_file_payload()
	if (!payload?.paths.length) return

	const result = await import_files_to_desktop({
		paths: payload.paths,
		to: monitor_id.trim() || fallback_monitor(desktop_layout.peek()),
		operation: payload.operation === "cut" ? "move" : "copy",
	})
	if (result.failures.length > 0 || payload.operation !== "cut") return
	if (
		clipboard_untouched(original_content) &&
		same_files(desktop_clipboard.peek()?.paths, payload.paths)
	)
		log_error(
			clear_clipboard_file_payload(),
			"desktop.paste_files: Failed to clear moved clipboard files",
		)
	update_desktop_clipboard(null)
}

export async function import_files_to_desktop(opts: {
	paths: string[]
	to: string
	operation: "copy" | "move"
}): Promise<desktop_transfer_result> {
	let visible_paths: string[] = []
	begin_desktop_transfer()
	try {
		const result = await transfer_desktop_files({
			paths: opts.paths,
			operation: opts.operation,
		})
		visible_paths = [
			...result.created_paths,
			...result.failures.flatMap((failure) =>
				failure.destination ? [failure.destination] : [],
			),
		]
		if (result.failures.length > 0)
			console.error(
				"desktop.import_files: Failed to import some desktop files",
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
	const result = await delete_desktop_files({
		paths,
		operation: opts.permanently ? "delete" : "trash",
	})
	if (result.failures.length)
		console.error("desktop.remove: Failed to remove files", result.failures)
	const removed = new Set(result.removed_paths)
	forget_paths((path) => removed.has(path))
	await reload_desktop_files()
}

export type desktop_entry_spec =
	| { kind: "folder" }
	| { kind: "file" }
	| ({ kind: "launcher" } & desktop_launcher_spec)

function create_entry(spec: desktop_entry_spec): result<string> {
	if (spec.kind === "folder") return create_desktop_folder()
	if (spec.kind === "file") return create_desktop_text_file()
	return create_desktop_launcher(spec)
}

export function create_desktop_entry(
	monitor_id: string,
	spec: desktop_entry_spec,
): string | null {
	const result = create_entry(spec)
	if (
		!log_error(result, `desktop.create: Failed to create desktop ${spec.kind}`)
	)
		return null
	update_layout(assign_paths(desktop_layout.peek(), [result.value], monitor_id))
	void reload_desktop_files(monitor_id)
	return result.value
}

function renamed_file(file: desktop_file, path: string): desktop_file {
	return {
		...file,
		path,
		name: base_name(path),
		display_name: is_launcher_path(path) ? file.display_name : undefined,
	}
}

function commit_rename(): string | null {
	const target = rename_path.peek()
	const name = rename_value.peek().trim()
	if (!target || !name || base_name(target) === name) return null
	const result = rename_file(target, name)
	if (!log_error(result, "desktop.rename: Failed to rename desktop file"))
		return null
	const path = result.value
	update_layout(rename_placement(desktop_layout.peek(), target, path))
	set_desktop_files(
		desktop_files
			.peek()
			.map((file) => (file.path === target ? renamed_file(file, path) : file)),
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
			const open = () => {
				set_rename_value(base_name(path))
				set_rename_path(path)
			}
			if (rename_path.peek() === path) {
				set_rename_path(null)
				idle(open)
			} else {
				open()
			}
			set_selected([path])
		},
		commit() {
			const path = commit_rename()
			if (path) set_selected([path])
			set_rename_path(null)
		},
		cancel() {
			set_rename_path(null)
		},
	},
}

void reload_desktop_files()
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
