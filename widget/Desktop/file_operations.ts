import { Gdk } from "ags/gtk4"
import { timeout } from "$lib/time"

import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"

import {
	attempt,
	attempt_async,
	err,
	log_error,
	ok,
	with_context,
	log_refusal,
	type result,
} from "$lib/result"
import { is_exists_error } from "$lib/files"
import { is_launcher_path } from "$lib/text"

export type desktop_file = {
	name: string
	display_name?: string
	path: string
	content_type: string
	modified?: Date
	icon: string
	icon_file?: string
}

export const desktop_path =
	GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) ??
	`${GLib.get_home_dir()}/Desktop`

function split_extension(name: string): [string, string] {
	const dot = name.lastIndexOf(".")
	if (dot <= 0) return [name, ""]
	return [name.slice(0, dot), name.slice(dot)]
}

function numbered_desktop_path(name: string, index: number) {
	if (!index) return `${desktop_path}/${name}`
	const [stem, extension] = split_extension(name)
	return `${desktop_path}/${stem} (${index})${extension}`
}

function unique_desktop_target_path(name: string) {
	let index = 0
	while (
		Gio.File.new_for_path(numbered_desktop_path(name, index)).query_exists(null)
	)
		index++
	return numbered_desktop_path(name, index)
}

export type desktop_transfer_result = {
	created_paths: string[]
	failures: Array<{ path: string; error: unknown; destination?: string }>
}

function confirm(
	done: result<boolean | undefined>,
	failure: string,
): result<void> {
	if (!done.ok) return done
	if (!done.value) return err(new Error(failure))
	return ok(undefined)
}

function partial_failure(message: string, cause: unknown, target: Gio.File) {
	return err(
		Object.assign(new Error(message, { cause }), {
			destination: target.get_path() ?? "",
		}),
	)
}

function would_recurse(error: unknown) {
	return (
		error instanceof GLib.Error &&
		error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.WOULD_RECURSE)
	)
}

function copy_async(source: Gio.File, target: Gio.File): Promise<result<void>> {
	return new Promise((resolve) =>
		source.copy_async(
			target,
			Gio.FileCopyFlags.NOFOLLOW_SYMLINKS,
			GLib.PRIORITY_DEFAULT,
			null,
			null,
			(file, res) => {
				const finished = attempt(() => file?.copy_finish(res))
				resolve(confirm(finished, "Copy returned false"))
			},
		),
	)
}

function move_async(source: Gio.File, target: Gio.File): Promise<result<void>> {
	return new Promise((resolve) =>
		source.move_async(
			target,
			Gio.FileCopyFlags.NONE,
			GLib.PRIORITY_DEFAULT,
			null,
			null,
			(file, res) => {
				const finished = attempt(() => file?.move_finish(res))
				resolve(confirm(finished, "Move returned false"))
			},
		),
	)
}

function query_type(file: Gio.File): Promise<result<Gio.FileType>> {
	return attempt_async(async () => {
		const info = await file.query_info_async(
			"standard::type",
			Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
			GLib.PRIORITY_DEFAULT,
			null,
		)
		return info.get_file_type()
	})
}

async function make_directory(target: Gio.File): Promise<result<void>> {
	return confirm(
		await attempt_async(() =>
			target.make_directory_async(GLib.PRIORITY_DEFAULT, null),
		),
		`Failed to create ${target.get_path()}`,
	)
}

async function close_enumerator(
	enumerator: Gio.FileEnumerator,
	dir: Gio.File,
): Promise<result<void>> {
	return confirm(
		await attempt_async(() =>
			enumerator.close_async(GLib.PRIORITY_DEFAULT, null),
		),
		`Failed to close directory ${dir.get_path()}`,
	)
}

async function for_each_child(
	dir: Gio.File,
	attributes: string,
	flags: Gio.FileQueryInfoFlags,
	visit: (info: Gio.FileInfo) => result<void> | Promise<result<void>>,
): Promise<result<void>> {
	const opened = await attempt_async(() =>
		dir.enumerate_children_async(
			attributes,
			flags,
			GLib.PRIORITY_DEFAULT,
			null,
		),
	)
	if (!opened.ok) return opened
	const enumerator = opened.value
	for (;;) {
		const batch = await attempt_async(() =>
			enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null),
		)
		if (!batch.ok) {
			const closed = await close_enumerator(enumerator, dir)
			if (!closed.ok) return closed
			return batch
		}
		if (batch.value.length === 0) return close_enumerator(enumerator, dir)
		for (const info of batch.value) {
			const visited = await visit(info)
			if (visited.ok) continue
			await close_enumerator(enumerator, dir)
			return visited
		}
	}
}

function for_each_child_name(
	dir: Gio.File,
	visit: (name: string) => Promise<result<void>>,
): Promise<result<void>> {
	return for_each_child(
		dir,
		"standard::name",
		Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
		(child) => visit(child.get_name()),
	)
}

async function delete_tree(file: Gio.File): Promise<result<void>> {
	const type = await query_type(file)
	if (!type.ok) return type
	if (type.value === Gio.FileType.DIRECTORY) {
		const emptied = await for_each_child_name(file, (name) =>
			delete_tree(file.get_child(name)),
		)
		if (!emptied.ok) return emptied
	}
	return confirm(
		await attempt_async(() => file.delete_async(GLib.PRIORITY_DEFAULT, null)),
		`Failed to delete ${file.get_path()}`,
	)
}

async function copy_tree(
	source: Gio.File,
	target: Gio.File,
): Promise<result<void>> {
	const type = await query_type(source)
	if (!type.ok) return type
	if (type.value !== Gio.FileType.DIRECTORY) {
		const copied = await copy_async(source, target)
		if (copied.ok || is_exists_error(copied.err)) return copied
		return partial_failure(
			`Incomplete copy may remain at ${target.get_path()}`,
			copied.err,
			target,
		)
	}
	const created = await make_directory(target)
	if (!created.ok) return created
	const filled = await for_each_child_name(source, (name) =>
		copy_tree(source.get_child(name), target.get_child(name)),
	)
	if (filled.ok) return filled
	return partial_failure(
		`Incomplete copy at ${target.get_path()}`,
		filled.err,
		target,
	)
}

async function move_tree(
	source: Gio.File,
	target: Gio.File,
): Promise<result<void>> {
	const moved = await move_async(source, target)
	if (moved.ok || !would_recurse(moved.err)) return moved
	const type = await query_type(source)
	if (!type.ok) return type
	if (type.value !== Gio.FileType.DIRECTORY)
		return err(
			new Error(`Cannot recursively move non-directory ${source.get_path()}`),
		)
	const created = await make_directory(target)
	if (!created.ok) return created
	const message = `Partial move to ${target.get_path()}`
	const drained = await for_each_child_name(source, (name) =>
		move_tree(source.get_child(name), target.get_child(name)),
	)
	if (!drained.ok) return partial_failure(message, drained.err, target)
	const removed = confirm(
		await attempt_async(() => source.delete_async(GLib.PRIORITY_DEFAULT, null)),
		`Failed to remove empty directory ${source.get_path()}`,
	)
	if (!removed.ok) return partial_failure(message, removed.err, target)
	return removed
}

function transfer_failure(path: string, error: unknown) {
	if (
		error instanceof Error &&
		"destination" in error &&
		typeof error.destination === "string"
	)
		return { path, error, destination: error.destination }
	return { path, error }
}

async function transfer_to_desktop(
	source_path: string,
	operation: "copy" | "move",
): Promise<result<string | null>> {
	if (!source_path) return err(new Error("Source path is empty"))
	if (!GLib.path_is_absolute(source_path))
		return err(new Error("Source must be an absolute local path"))
	const source = Gio.File.new_for_path(source_path)
	const name = source.get_basename()
	if (!name) return err(new Error("Source has no basename"))
	const in_place = Gio.File.new_for_path(numbered_desktop_path(name, 0))
	if (operation === "move" && source.equal(in_place)) return ok(null)
	const transfer = operation === "move" ? move_tree : copy_tree
	for (let index = 0; index < 10000; index++) {
		const target_path = numbered_desktop_path(name, index)
		const target = Gio.File.new_for_path(target_path)
		if (target.has_prefix(source))
			return err(new Error("Cannot transfer a directory into itself"))
		const transferred = await transfer(source, target)
		if (transferred.ok) return ok(target_path)
		if (!is_exists_error(transferred.err)) return transferred
	}
	return err(new Error("No available destination name"))
}

export async function transfer_desktop_files(opts: {
	paths: string[]
	operation: "copy" | "move"
}): Promise<desktop_transfer_result> {
	const created_paths: string[] = []
	const failures: desktop_transfer_result["failures"] = []
	for (const source_path of new Set(opts.paths)) {
		const transferred = await transfer_to_desktop(source_path, opts.operation)
		if (!transferred.ok)
			failures.push(transfer_failure(source_path, transferred.err))
		else if (transferred.value) created_paths.push(transferred.value)
	}
	return { created_paths, failures }
}

type desktop_remove_result = {
	removed_paths: string[]
	failures: desktop_transfer_result["failures"]
}

async function remove_desktop_entry(
	path: string,
	operation: "trash" | "delete",
): Promise<result<void>> {
	const file = Gio.File.new_for_path(path)
	if (!file.get_parent()?.equal(Gio.File.new_for_path(desktop_path)))
		return err(new Error("Can only remove desktop entries"))
	if (operation === "delete") return delete_tree(file)
	return confirm(
		await attempt_async(() => file.trash_async(GLib.PRIORITY_DEFAULT, null)),
		"Trash returned false",
	)
}

export async function delete_desktop_files({
	paths,
	operation,
}: {
	paths: string[]
	operation: "trash" | "delete"
}): Promise<desktop_remove_result> {
	const removed_paths: string[] = []
	const failures: desktop_transfer_result["failures"] = []
	for (const path of new Set(paths)) {
		const removed = await remove_desktop_entry(path, operation)
		if (removed.ok) removed_paths.push(path)
		else failures.push({ path, error: removed.err })
	}
	return { removed_paths, failures }
}

function is_valid_basename(name: string) {
	return (
		!!name.trim() &&
		name !== "." &&
		name !== ".." &&
		!name.includes("/") &&
		!name.includes("\0")
	)
}

function rename_in_place(old_path: string, new_name: string): result<string> {
	if (!is_valid_basename(new_name))
		return err(new Error("Rename requires a valid basename"))
	const file = Gio.File.new_for_path(old_path)
	const parent = file.get_parent()
	if (!parent)
		return err(new Error("Cannot rename file without parent directory"))

	const parent_path = parent.get_path()
	if (!parent_path)
		return err(new Error("Cannot resolve parent path for rename"))

	const new_path = `${parent_path}/${new_name}`
	if (new_path === old_path) return ok(old_path)

	const new_file = Gio.File.new_for_path(new_path)
	if (new_file.query_exists(null))
		return err(new Error(`Target already exists: ${new_path}`))

	const moved = confirm(
		attempt(() => file.move(new_file, Gio.FileCopyFlags.NONE, null, null)),
		"Rename returned false",
	)
	if (!moved.ok) return moved
	return ok(new_path)
}

export function rename_file(
	old_path: string,
	new_name: string,
): result<string> {
	return with_context(
		rename_in_place(old_path, new_name),
		`Failed to rename ${old_path}`,
	)
}

export function create_desktop_folder(): result<string> {
	let folder_name = "New Folder"
	let counter = 1

	while (
		Gio.File.new_for_path(`${desktop_path}/${folder_name}`).query_exists(null)
	)
		folder_name = `New Folder ${counter++}`

	const new_path = `${desktop_path}/${folder_name}`
	const created = confirm(
		attempt(() => Gio.File.new_for_path(new_path).make_directory(null)),
		"Folder creation returned false",
	)
	if (!created.ok)
		return with_context(created, "Failed to create desktop folder")
	return ok(new_path)
}

export function create_desktop_text_file(): result<string> {
	const failure = "Failed to create desktop text file"
	const path = unique_desktop_target_path("New Text File.txt")
	const stream = attempt(() =>
		Gio.File.new_for_path(path).create(Gio.FileCreateFlags.NONE, null),
	)
	if (!stream.ok) return with_context(stream, failure)
	const closed = confirm(
		attempt(() => stream.value.close(null)),
		"Text file close returned false",
	)
	if (!closed.ok) return with_context(closed, failure)
	return ok(path)
}

export type desktop_launcher_spec = {
	name: string
	comment?: string
	command: string
	icon?: string
	working_directory?: string
	terminal?: boolean
}

function desktop_launcher_file_name(name: string) {
	const stem = name
		.trim()
		.replace(/\.desktop$/i, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return `${stem || "launcher"}.desktop`
}

const desktop_entry = "Desktop Entry"

function launcher_key_file(
	spec: desktop_launcher_spec,
	name: string,
	command: string,
) {
	const key_file = new GLib.KeyFile()
	key_file.set_string(desktop_entry, "Type", "Application")
	key_file.set_string(desktop_entry, "Name", name)
	key_file.set_string(desktop_entry, "Exec", command)
	key_file.set_boolean(desktop_entry, "Terminal", !!spec.terminal)
	key_file.set_boolean(desktop_entry, "StartupNotify", true)
	const optional = {
		Comment: spec.comment,
		Icon: spec.icon,
		Path: spec.working_directory,
	}
	for (const [key, value] of Object.entries(optional)) {
		const trimmed = value?.trim()
		if (trimmed) key_file.set_string(desktop_entry, key, trimmed)
	}
	return key_file
}

function fill_launcher(
	file: Gio.File,
	stream: Gio.FileOutputStream,
	contents: string,
): result<void> {
	const written = confirm(
		attempt(
			() => stream.write_all(new TextEncoder().encode(contents), null)[0],
		),
		"Could not write launcher",
	)
	if (!written.ok) return written
	const closed = confirm(
		attempt(() => stream.close(null)),
		"Launcher close returned false",
	)
	if (!closed.ok) return closed
	const executable = confirm(
		attempt(() =>
			file.set_attribute_uint32(
				"unix::mode",
				0o755,
				Gio.FileQueryInfoFlags.NONE,
				null,
			),
		),
		"Could not set launcher mode",
	)
	if (!executable.ok) return executable
	return confirm(
		attempt(() =>
			file.set_attribute_string(
				"metadata::trusted",
				"true",
				Gio.FileQueryInfoFlags.NONE,
				null,
			),
		),
		"Could not mark launcher as trusted",
	)
}

function discard_launcher(
	file: Gio.File,
	stream: Gio.FileOutputStream,
	path: string,
) {
	log_refusal(
		attempt(() => stream.close(null)),
		`desktop.create_launcher: Failed to close ${path}`,
		"close returned false",
	)
	log_refusal(
		attempt(() => file.delete(null)),
		`desktop.create_launcher: Failed to remove incomplete launcher ${path}`,
		"delete returned false",
	)
}

function write_launcher(spec: desktop_launcher_spec): result<string> {
	const name = spec.name.trim()
	const command = spec.command.trim()
	if (!name) return err(new Error("Launcher name is required"))
	if (!command) return err(new Error("Launcher command is required"))

	const path = unique_desktop_target_path(desktop_launcher_file_name(name))
	const key_file = launcher_key_file(spec, name, command)
	const file = Gio.File.new_for_path(path)
	const contents = attempt(() => key_file.to_data()[0])
	if (!contents.ok) return contents
	const stream = attempt(() => file.create(Gio.FileCreateFlags.NONE, null))
	if (!stream.ok) return stream

	const filled = fill_launcher(file, stream.value, contents.value)
	if (filled.ok) return ok(path)
	discard_launcher(file, stream.value, path)
	return filled
}

export function create_desktop_launcher(
	spec: desktop_launcher_spec,
): result<string> {
	return with_context(write_launcher(spec), "Failed to create desktop launcher")
}

const generic_icon = "text-x-generic"
export const directory_type = "inode/directory"

function first_icon_name(icon: Gio.Icon | null): string | null {
	if (!icon) return null
	const get_names = Reflect.get(icon, "get_names")
	if (typeof get_names !== "function") return null
	const names = get_names.call(icon)
	if (!Array.isArray(names)) return null
	if (typeof names[0] !== "string") return null
	return names[0]
}

function icon_name_from_file_info(info: Gio.FileInfo): string {
	const own = first_icon_name(info.get_icon())
	if (own) return own

	const content_type = info.get_content_type()
	if (!content_type) return generic_icon
	const themed = attempt(() =>
		first_icon_name(Gio.content_type_get_icon(content_type)),
	)
	if (themed.ok && themed.value !== null) return themed.value
	return generic_icon
}

function is_trusted_launcher(info: Gio.FileInfo): boolean {
	return (
		info.get_attribute_string("metadata::trusted") === "true" &&
		info.get_attribute_boolean("access::can-execute")
	)
}

function desktop_launcher_metadata(path: string, info: Gio.FileInfo) {
	if (!is_launcher_path(path)) return null
	if (!is_trusted_launcher(info)) return null
	const read = attempt(() => read_launcher(path))
	if (!read.ok) return null
	return read.value
}

function read_launcher(path: string) {
	const launcher = GioUnix.DesktopAppInfo.new_from_filename(path)
	if (!launcher) return null
	const themed = first_icon_name(launcher.get_icon())
	const icon_value = launcher.get_string("Icon") ?? ""
	const absolute = GLib.path_is_absolute(icon_value)
	let icon = themed
	if (!icon && icon_value && !absolute) icon = icon_value
	return {
		display_name: launcher.get_display_name() || launcher.get_name(),
		icon,
		icon_file: absolute ? icon_value : null,
	}
}

function content_type_of(info: Gio.FileInfo, path: string): string {
	if (info.get_file_type() === Gio.FileType.DIRECTORY) return directory_type
	const reported = info.get_content_type()
	if (reported) return reported
	return Gio.content_type_guess(path, null)[0] || "application/octet-stream"
}

function desktop_file_from_info(file_info: Gio.FileInfo): desktop_file {
	const file_name = file_info.get_name()
	const file_path = `${desktop_path}/${file_name}`
	const launcher = desktop_launcher_metadata(file_path, file_info)

	return {
		name: file_name,
		display_name: launcher?.display_name,
		path: file_path,
		content_type: content_type_of(file_info, file_path),
		modified: new Date(
			(file_info.get_modification_date_time()?.to_unix() || 0) * 1000,
		),
		icon: launcher?.icon ?? icon_name_from_file_info(file_info),
		icon_file: launcher?.icon_file ?? undefined,
	}
}

export async function load_desktop_files(): Promise<result<desktop_file[]>> {
	const found_files: desktop_file[] = []
	const scanned = await for_each_child(
		Gio.File.new_for_path(desktop_path),
		"standard::name,standard::type,time::modified,standard::content-type,standard::icon,access::can-execute,metadata::trusted",
		Gio.FileQueryInfoFlags.NONE,
		(file_info) => {
			if (!file_info.get_name().startsWith("."))
				found_files.push(desktop_file_from_info(file_info))
			return ok(undefined)
		},
	)
	if (!scanned.ok)
		return with_context(scanned, "Failed to scan desktop directory")
	return ok(found_files.sort(compare_desktop_files))
}

function compare_desktop_files(
	left: desktop_file,
	right: desktop_file,
): number {
	const left_is_directory = left.content_type === directory_type
	const right_is_directory = right.content_type === directory_type
	if (left_is_directory !== right_is_directory)
		return left_is_directory ? -1 : 1
	return left.name.localeCompare(right.name)
}

function launch_default(file_path: string): result<void> {
	const uri = Gio.File.new_for_path(file_path).get_uri()
	return confirm(
		attempt(() => Gio.app_info_launch_default_for_uri(uri, null)),
		"Default application returned false",
	)
}

function launch(file_path: string): result<void> {
	if (!is_launcher_path(file_path)) return launch_default(file_path)
	const info = attempt(() =>
		Gio.File.new_for_path(file_path).query_info(
			"access::can-execute,metadata::trusted",
			Gio.FileQueryInfoFlags.NONE,
			null,
		),
	)
	if (!info.ok) return info
	if (!is_trusted_launcher(info.value))
		return err(new Error("Refusing to launch an untrusted desktop entry"))

	const launcher = GioUnix.DesktopAppInfo.new_from_filename(file_path)
	if (!launcher) return launch_default(file_path)
	return confirm(
		attempt(() => launcher.launch([], null)),
		"Launcher returned false",
	)
}

export function open_path(file_path: string): result<void> {
	return with_context(launch(file_path), `Failed to open ${file_path}`)
}

export type clipboard_file_payload = {
	operation: "copy" | "cut"
	paths: string[]
}

const gnome_copied_files = "x-special/gnome-copied-files"
const uri_list = "text/uri-list"

export function build_file_content_provider({
	paths,
	operation,
}: clipboard_file_payload) {
	const files = paths.map((path) => Gio.File.new_for_path(path))
	const uris = files.map((file) => file.get_uri())
	const encoder = new TextEncoder()
	return Gdk.ContentProvider.new_union([
		Gdk.ContentProvider.new_for_value(Gdk.FileList.new_from_array(files)),
		Gdk.ContentProvider.new_for_bytes(
			uri_list,
			encoder.encode(`${uris.join("\r\n")}\r\n`),
		),
		Gdk.ContentProvider.new_for_bytes(
			gnome_copied_files,
			encoder.encode(`${operation}\n${uris.join("\n")}`),
		),
	])
}

function set_desktop_clipboard(
	content: () => Gdk.ContentProvider | null,
	failure: string,
): result<void> {
	const display = Gdk.Display.get_default()
	if (!display) return err(new Error("No display for desktop clipboard"))
	const set = attempt(() => display.get_clipboard().set_content(content()))
	if (!set.ok) return err(new Error(failure, { cause: set.err }))
	if (!set.value) return err(new Error(failure))
	return ok(undefined)
}

export function write_clipboard_file_payload(
	payload: clipboard_file_payload,
): result<void> {
	if (payload.paths.length === 0) return ok(undefined)
	return set_desktop_clipboard(
		() => build_file_content_provider(payload),
		"Failed to write desktop clipboard payload",
	)
}

export function clear_clipboard_file_payload(): result<void> {
	return set_desktop_clipboard(
		() => null,
		"Failed to clear desktop clipboard payload",
	)
}

export function paths_from_uris(uris: string[]): string[] {
	const paths: string[] = []
	for (const uri of uris) {
		if (!uri.startsWith("file://")) continue
		const result = attempt(() => Gio.File.new_for_uri(uri).get_path())
		if (!log_error(result, "desktop.file_uris: Invalid local file URI"))
			continue
		if (result.value && GLib.path_is_absolute(result.value))
			paths.push(result.value)
	}
	return paths
}

async function read_chunks(
	stream: Gio.InputStream,
	cancellable: Gio.Cancellable | null,
): Promise<result<Uint8Array[]>> {
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const read = await attempt_async(() =>
			stream.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, cancellable),
		)
		if (!read.ok) return read
		const chunk = read.value.get_data()
		if (!chunk?.length) return ok(chunks)
		size += chunk.length
		if (size > 1024 * 1024) return err(new Error("File URI list exceeds 1 MiB"))
		chunks.push(chunk)
	}
}

async function close_stream(stream: Gio.InputStream): Promise<result<void>> {
	return confirm(
		await attempt_async(() => stream.close_async(GLib.PRIORITY_DEFAULT, null)),
		"Failed to close file URI stream",
	)
}

function decode_chunks(chunks: Uint8Array[]): string {
	const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
	const data = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		data.set(chunk, offset)
		offset += chunk.length
	}
	return new TextDecoder().decode(data)
}

export async function read_file_text(
	stream: Gio.InputStream,
	cancellable: Gio.Cancellable | null = null,
): Promise<result<string>> {
	const chunks = await read_chunks(stream, cancellable)
	const closed = await close_stream(stream)
	if (!closed.ok) return closed
	if (!chunks.ok) return chunks
	return ok(decode_chunks(chunks.value))
}

function split_payload_lines(text: string): string[] {
	return text
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.filter(Boolean)
}

export function uri_list_paths(text: string): string[] {
	return paths_from_uris(
		split_payload_lines(text).filter((line) => !line.startsWith("#")),
	)
}

const clipboard_mime_types = [gnome_copied_files, uri_list]

async function read_clipboard_text(
	clipboard: Gdk.Clipboard,
	cancellable: Gio.Cancellable,
): Promise<result<{ mime: string | null; text: string }>> {
	const opened = await attempt_async(() =>
		clipboard.read_async(
			clipboard_mime_types,
			GLib.PRIORITY_DEFAULT,
			cancellable,
		),
	)
	if (!opened.ok) return opened
	const [stream, mime] = opened.value
	if (!stream) return err(new Error("Clipboard provided no stream"))
	const text = await read_file_text(stream, cancellable)
	if (!text.ok) return text
	return ok({ mime, text: text.value })
}

function gnome_copied_payload(text: string): clipboard_file_payload | null {
	const [operation, ...uris] = split_payload_lines(text)
	const paths = paths_from_uris(uris)
	if (paths.length === 0) return null
	return { operation: operation === "cut" ? "cut" : "copy", paths }
}

function uri_list_payload(text: string): clipboard_file_payload | null {
	const paths = uri_list_paths(text)
	if (paths.length === 0) return null
	return { operation: "copy", paths }
}

export async function read_clipboard_file_payload(): Promise<clipboard_file_payload | null> {
	const clipboard = Gdk.Display.get_default()?.get_clipboard()
	if (!clipboard) return null
	const formats = clipboard.get_formats()
	if (!clipboard_mime_types.some((mime) => formats.contain_mime_type(mime)))
		return null
	const cancellable = new Gio.Cancellable()
	const deadline = timeout(30_000, () => cancellable.cancel())
	const read = await read_clipboard_text(clipboard, cancellable)
	deadline.cancel()
	if (!log_error(read, "desktop.clipboard: Failed to read clipboard"))
		return null
	const { mime, text } = read.value
	if (mime === gnome_copied_files) return gnome_copied_payload(text)
	return uri_list_payload(text)
}
