import { execAsync } from "ags/process"
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
	type Result,
} from "$lib/result"

export type DesktopFile = {
	name: string
	displayName?: string
	path: string
	contentType: string
	modified?: Date
	icon: string
	iconFile?: string
}

export const DESKTOP_PATH =
	GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) ??
	`${GLib.get_home_dir()}/Desktop`

function unique_desktop_target_path(base_name: string) {
	const last_dot = base_name.lastIndexOf(".")
	const has_ext = last_dot > 0
	const stem = has_ext ? base_name.slice(0, last_dot) : base_name
	const ext = has_ext ? base_name.slice(last_dot) : ""
	let counter = 1
	let candidate = `${DESKTOP_PATH}/${base_name}`

	while (Gio.File.new_for_path(candidate).query_exists(null)) {
		candidate = `${DESKTOP_PATH}/${stem} (${counter++})${ext}`
	}

	return candidate
}

export type DesktopTransferResult = {
	createdPaths: string[]
	failures: Array<{ path: string; error: unknown; destination?: string }>
}

function is_exists(error: unknown): boolean {
	return (
		error instanceof GLib.Error &&
		error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.EXISTS)
	)
}

function copy_async(source: Gio.File, target: Gio.File): Promise<void> {
	return new Promise((resolve, reject) => {
		source.copy_async(
			target,
			Gio.FileCopyFlags.NOFOLLOW_SYMLINKS,
			GLib.PRIORITY_DEFAULT,
			null,
			null,
			(file, result) => {
				try {
					if (!file?.copy_finish(result)) throw new Error("Copy returned false")
					resolve()
				} catch (error) {
					reject(error)
				}
			},
		)
	})
}

function move_async(source: Gio.File, target: Gio.File): Promise<void> {
	return new Promise((resolve, reject) => {
		source.move_async(
			target,
			Gio.FileCopyFlags.NONE,
			GLib.PRIORITY_DEFAULT,
			null,
			null,
			(file, result) => {
				try {
					if (!file?.move_finish(result)) throw new Error("Move returned false")
					resolve()
				} catch (error) {
					reject(error)
				}
			},
		)
	})
}

async function* children_of(file: Gio.File): AsyncGenerator<Gio.File> {
	const enumerator = await file.enumerate_children_async(
		"standard::name",
		Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
		GLib.PRIORITY_DEFAULT,
		null,
	)
	try {
		for (;;) {
			const batch = await enumerator.next_files_async(
				64,
				GLib.PRIORITY_DEFAULT,
				null,
			)
			if (batch.length === 0) break
			for (const info of batch) yield file.get_child(info.get_name())
		}
	} finally {
		if (!(await enumerator.close_async(GLib.PRIORITY_DEFAULT, null)))
			throw new Error(`Failed to close directory ${file.get_path()}`)
	}
}

async function delete_tree(file: Gio.File): Promise<void> {
	const info = await file.query_info_async(
		"standard::type",
		Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
		GLib.PRIORITY_DEFAULT,
		null,
	)
	if (info.get_file_type() === Gio.FileType.DIRECTORY) {
		for await (const child of children_of(file)) await delete_tree(child)
	}
	if (!(await file.delete_async(GLib.PRIORITY_DEFAULT, null)))
		throw new Error(`Failed to delete ${file.get_path()}`)
}

async function copy_tree(source: Gio.File, target: Gio.File): Promise<void> {
	const info = await source.query_info_async(
		"standard::type",
		Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
		GLib.PRIORITY_DEFAULT,
		null,
	)
	if (info.get_file_type() !== Gio.FileType.DIRECTORY) {
		try {
			await copy_async(source, target)
		} catch (error) {
			if (is_exists(error)) throw error
			throw new Error(`Incomplete copy may remain at ${target.get_path()}`, {
				cause: error,
			})
		}
		return
	}
	if (!(await target.make_directory_async(GLib.PRIORITY_DEFAULT, null)))
		throw new Error(`Failed to create ${target.get_path()}`)
	try {
		for await (const child of children_of(source)) {
			const name = child.get_basename()
			if (!name) throw new Error(`Cannot name child of ${source.get_path()}`)
			await copy_tree(child, target.get_child(name))
		}
	} catch (error) {
		throw new Error(`Incomplete copy at ${target.get_path()}`, { cause: error })
	}
}

async function move_tree(source: Gio.File, target: Gio.File): Promise<void> {
	try {
		await move_async(source, target)
		return
	} catch (error) {
		if (
			!(
				error instanceof GLib.Error &&
				error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.WOULD_RECURSE)
			)
		)
			throw error
	}
	const info = await source.query_info_async(
		"standard::type",
		Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
		GLib.PRIORITY_DEFAULT,
		null,
	)
	if (info.get_file_type() !== Gio.FileType.DIRECTORY)
		throw new Error(
			`Cannot recursively move non-directory ${source.get_path()}`,
		)
	if (!(await target.make_directory_async(GLib.PRIORITY_DEFAULT, null)))
		throw new Error(`Failed to create ${target.get_path()}`)
	try {
		for await (const child of children_of(source)) {
			const name = child.get_basename()
			if (!name) throw new Error(`Cannot name child of ${source.get_path()}`)
			await move_tree(child, target.get_child(name))
		}
		if (!(await source.delete_async(GLib.PRIORITY_DEFAULT, null)))
			throw new Error(`Failed to remove empty directory ${source.get_path()}`)
	} catch (error) {
		throw Object.assign(
			new Error(`Partial move to ${target.get_path()}`, { cause: error }),
			{
				destination: target.get_path() ?? "",
			},
		)
	}
}

export async function transfer_desktop_files(opts: {
	paths: string[]
	operation: "copy" | "move"
}): Promise<DesktopTransferResult> {
	const created_paths: string[] = []
	const failures: DesktopTransferResult["failures"] = []
	for (const source_path of new Set(opts.paths)) {
		try {
			if (!source_path) throw new Error("Source path is empty")
			if (!GLib.path_is_absolute(source_path))
				throw new Error("Source must be an absolute local path")
			const source = Gio.File.new_for_path(source_path)
			const name = source.get_basename()
			if (!name) throw new Error("Source has no basename")
			if (
				opts.operation === "move" &&
				source.equal(Gio.File.new_for_path(`${DESKTOP_PATH}/${name}`))
			)
				continue
			const dot = name.lastIndexOf(".")
			const stem = dot > 0 ? name.slice(0, dot) : name
			const extension = dot > 0 ? name.slice(dot) : ""
			let completed = false
			for (let index = 0; index < 10000; index++) {
				const target_path = `${DESKTOP_PATH}/${index ? `${stem} (${index})${extension}` : name}`
				const target = Gio.File.new_for_path(target_path)
				try {
					if (target.has_prefix(source))
						throw new Error("Cannot transfer a directory into itself")
					if (opts.operation === "move") await move_tree(source, target)
					else await copy_tree(source, target)
					created_paths.push(target_path)
					completed = true
					break
				} catch (error) {
					if (!is_exists(error)) throw error
				}
			}
			if (!completed) throw new Error("No available destination name")
		} catch (error) {
			if (
				error instanceof Error &&
				"destination" in error &&
				typeof error.destination === "string"
			)
				failures.push({
					path: source_path,
					error,
					destination: error.destination,
				})
			else failures.push({ path: source_path, error })
		}
	}
	return { createdPaths: created_paths, failures }
}

type desktop_remove_result = {
	removedPaths: string[]
	failures: DesktopTransferResult["failures"]
}

async function mutate_desktop_files(
	paths: string[],
	operation: "trash" | "delete",
): Promise<desktop_remove_result> {
	const removed_paths: string[] = []
	const failures: DesktopTransferResult["failures"] = []
	for (const path of new Set(paths)) {
		try {
			const file = Gio.File.new_for_path(path)
			if (!file.get_parent()?.equal(Gio.File.new_for_path(DESKTOP_PATH)))
				throw new Error("Can only remove desktop entries")
			if (operation === "trash") {
				if (!(await file.trash_async(GLib.PRIORITY_DEFAULT, null)))
					throw new Error("Trash returned false")
			} else await delete_tree(file)
			removed_paths.push(path)
		} catch (error) {
			failures.push({ path, error })
		}
	}
	return { removedPaths: removed_paths, failures }
}

export function trash_files(paths: string[]): Promise<desktop_remove_result> {
	return mutate_desktop_files(paths, "trash")
}

export function permanently_delete_files(
	paths: string[],
): Promise<desktop_remove_result> {
	return mutate_desktop_files(paths, "delete")
}

export function rename_file(
	old_path: string,
	new_name: string,
): Result<string> {
	const result = attempt(() => {
		if (
			!new_name.trim() ||
			new_name === "." ||
			new_name === ".." ||
			new_name.includes("/") ||
			new_name.includes("\0")
		)
			throw new Error("Rename requires a valid basename")
		const file = Gio.File.new_for_path(old_path)
		const parent = file.get_parent()
		if (!parent) throw new Error("Cannot rename file without parent directory")

		const parent_path = parent.get_path()
		if (!parent_path) throw new Error("Cannot resolve parent path for rename")

		const new_path = `${parent_path}/${new_name}`
		if (new_path === old_path) return old_path

		const new_file = Gio.File.new_for_path(new_path)
		if (new_file.query_exists(null))
			throw new Error(`Target already exists: ${new_path}`)

		if (!file.move(new_file, Gio.FileCopyFlags.NONE, null, null))
			throw new Error("Rename returned false")
		return new_path
	})

	return with_context(result, `Failed to rename ${old_path}`)
}

export function create_desktop_folder(): Result<string> {
	const result = attempt(() => {
		let folder_name = "New Folder"
		let counter = 1

		while (
			Gio.File.new_for_path(`${DESKTOP_PATH}/${folder_name}`).query_exists(null)
		) {
			folder_name = `New Folder ${counter++}`
		}

		const new_path = `${DESKTOP_PATH}/${folder_name}`
		const folder = Gio.File.new_for_path(new_path)
		if (!folder.make_directory(null))
			throw new Error("Folder creation returned false")

		return new_path
	})

	return with_context(result, "Failed to create desktop folder")
}

export function create_desktop_text_file(): Result<string> {
	const result = attempt(() => {
		const path = unique_desktop_target_path("New Text File.txt")
		const stream = Gio.File.new_for_path(path).create(
			Gio.FileCreateFlags.NONE,
			null,
		)
		if (!stream.close(null)) throw new Error("Text file close returned false")
		return path
	})

	return with_context(result, "Failed to create desktop text file")
}

export type DesktopLauncherSpec = {
	name: string
	comment?: string
	command: string
	icon?: string
	workingDirectory?: string
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

export function create_desktop_launcher(
	spec: DesktopLauncherSpec,
): Result<string> {
	const result = attempt(() => {
		const name = spec.name.trim()
		const command = spec.command.trim()
		if (!name) throw new Error("Launcher name is required")
		if (!command) throw new Error("Launcher command is required")

		const path = unique_desktop_target_path(desktop_launcher_file_name(name))
		const key_file = new GLib.KeyFile()
		key_file.set_string("Desktop Entry", "Type", "Application")
		key_file.set_string("Desktop Entry", "Name", name)
		key_file.set_string("Desktop Entry", "Exec", command)
		key_file.set_boolean("Desktop Entry", "Terminal", !!spec.terminal)
		key_file.set_boolean("Desktop Entry", "StartupNotify", true)
		if (spec.comment?.trim())
			key_file.set_string("Desktop Entry", "Comment", spec.comment.trim())
		if (spec.icon?.trim())
			key_file.set_string("Desktop Entry", "Icon", spec.icon.trim())
		if (spec.workingDirectory?.trim())
			key_file.set_string("Desktop Entry", "Path", spec.workingDirectory.trim())

		const file = Gio.File.new_for_path(path)
		const [contents] = key_file.to_data()
		const stream = file.create(Gio.FileCreateFlags.NONE, null)
		try {
			const [written] = stream.write_all(
				new TextEncoder().encode(contents),
				null,
			)
			if (!written) throw new Error("Could not write launcher")
			if (!stream.close(null)) throw new Error("Launcher close returned false")
			if (
				!file.set_attribute_uint32(
					"unix::mode",
					0o755,
					Gio.FileQueryInfoFlags.NONE,
					null,
				)
			)
				throw new Error("Could not set launcher mode")
			if (
				!file.set_attribute_string(
					"metadata::trusted",
					"true",
					Gio.FileQueryInfoFlags.NONE,
					null,
				)
			)
				throw new Error("Could not mark launcher as trusted")
		} catch (error) {
			const closed = attempt(() => stream.close(null))
			if (!closed.ok || !closed.value)
				console.error(
					`desktop.createLauncher: Failed to close ${path}`,
					closed.ok ? "close returned false" : closed.err,
				)
			const cleanup = attempt(() => file.delete(null))
			if (!cleanup.ok || !cleanup.value)
				console.error(
					`desktop.createLauncher: Failed to remove incomplete launcher ${path}`,
					cleanup.ok ? "delete returned false" : cleanup.err,
				)
			throw error
		}
		return path
	})

	return with_context(result, "Failed to create desktop launcher")
}

function first_icon_name(icon: Gio.Icon | null) {
	if (!icon) return null
	const get_names = Reflect.get(icon, "get_names")
	if (typeof get_names !== "function") return null
	const names = get_names.call(icon)
	return Array.isArray(names) && typeof names[0] === "string" ? names[0] : null
}

function try_get_content_type_icon_name(content_type: string) {
	const result = attempt(() =>
		first_icon_name(Gio.content_type_get_icon(content_type)),
	)
	return result.ok ? result.value : null
}

function icon_name_from_file_info(info: Gio.FileInfo): string {
	const icon_name = first_icon_name(info.get_icon())
	if (icon_name) return icon_name

	const content_type = info.get_content_type()
	return content_type
		? (try_get_content_type_icon_name(content_type) ?? "text-x-generic")
		: "text-x-generic"
}

function desktop_launcher_metadata(path: string) {
	if (!path.toLowerCase().endsWith(".desktop")) return null
	const result = attempt(() => {
		const launcher = GioUnix.DesktopAppInfo.new_from_filename(path)
		if (!launcher) return null
		const icon_name = first_icon_name(launcher.get_icon())
		const icon_value = launcher.get_string("Icon") ?? ""
		let icon = icon_name
		if (!icon && icon_value && !GLib.path_is_absolute(icon_value))
			icon = icon_value
		return {
			displayName: launcher.get_display_name() || launcher.get_name(),
			icon,
			iconFile: GLib.path_is_absolute(icon_value) ? icon_value : null,
		}
	})
	return result.ok ? result.value : null
}

export async function load_desktop_files(): Promise<Result<DesktopFile[]>> {
	const desktop_dir = Gio.File.new_for_path(DESKTOP_PATH)
	const result = await attempt_async(async () => {
		const file_enum = await desktop_dir.enumerate_children_async(
			"standard::name,standard::type,time::modified,standard::content-type,standard::icon",
			Gio.FileQueryInfoFlags.NONE,
			GLib.PRIORITY_DEFAULT,
			null,
		)

		const found_files: DesktopFile[] = []
		try {
			for (;;) {
				const batch = await file_enum.next_files_async(
					64,
					GLib.PRIORITY_DEFAULT,
					null,
				)
				if (batch.length === 0) break
				for (const file_info of batch) {
					const file_name = file_info.get_name()
					if (file_name.startsWith(".")) continue

					const is_directory =
						file_info.get_file_type() === Gio.FileType.DIRECTORY
					const file_path = `${DESKTOP_PATH}/${file_name}`
					const file_type = is_directory
						? "inode/directory"
						: file_info.get_content_type() ||
							Gio.content_type_guess(file_path, null)[0] ||
							"application/octet-stream"
					const launcher = desktop_launcher_metadata(file_path)

					found_files.push({
						name: file_name,
						displayName: launcher?.displayName,
						path: file_path,
						contentType: file_type,
						modified: new Date(
							(file_info.get_modification_date_time()?.to_unix() || 0) * 1000,
						),
						icon: launcher?.icon ?? icon_name_from_file_info(file_info),
						iconFile: launcher?.iconFile ?? undefined,
					})
				}
			}
		} finally {
			if (!(await file_enum.close_async(GLib.PRIORITY_DEFAULT, null)))
				throw new Error(`Failed to close directory ${DESKTOP_PATH}`)
		}

		return found_files.sort(compare_desktop_files)
	})

	return with_context(result, "Failed to scan desktop directory")
}

function compare_desktop_files(left: DesktopFile, right: DesktopFile): number {
	const left_is_directory = left.contentType === "inode/directory"
	const right_is_directory = right.contentType === "inode/directory"
	if (left_is_directory && !right_is_directory) return -1
	if (!left_is_directory && right_is_directory) return 1
	return left.name.localeCompare(right.name)
}

export function open_path(file_path: string): Result<void> {
	const result = attempt(() => {
		if (file_path.toLowerCase().endsWith(".desktop")) {
			const info = Gio.File.new_for_path(file_path).query_info(
				"access::can-execute,metadata::trusted",
				Gio.FileQueryInfoFlags.NONE,
				null,
			)
			const trusted = info.get_attribute_string("metadata::trusted") === "true"
			if (!trusted || !info.get_attribute_boolean("access::can-execute"))
				throw new Error("Refusing to launch an untrusted desktop entry")

			const launcher = GioUnix.DesktopAppInfo.new_from_filename(file_path)
			if (launcher) {
				if (!launcher.launch([], null))
					throw new Error("Launcher returned false")
				return
			}
		}

		const file_obj = Gio.File.new_for_path(file_path)
		if (!Gio.app_info_launch_default_for_uri(file_obj.get_uri(), null))
			throw new Error("Default application returned false")
	})
	return with_context(result, `Failed to open ${file_path}`)
}

export type ClipboardFilePayload = {
	operation: "copy" | "cut"
	files: string[]
}

type clipboard_operation = ClipboardFilePayload["operation"]

function string_to_bytes(value: string) {
	return new TextEncoder().encode(value)
}

function serialize_clipboard_file_payload(
	paths: string[],
	operation: clipboard_operation,
) {
	const files = paths.map((path) => Gio.File.new_for_path(path))
	const uris = files.map((file) => file.get_uri())
	return {
		files,
		uri_list: `${uris.join("\r\n")}\r\n`,
		gnome_payload: `${operation}\n${uris.join("\n")}`,
	}
}

export function build_file_content_provider(
	paths: string[],
	operation: clipboard_operation,
) {
	const payload = serialize_clipboard_file_payload(paths, operation)
	return Gdk.ContentProvider.new_union([
		Gdk.ContentProvider.new_for_value(
			Gdk.FileList.new_from_array(payload.files),
		),
		Gdk.ContentProvider.new_for_bytes(
			"text/uri-list",
			string_to_bytes(payload.uri_list),
		),
		Gdk.ContentProvider.new_for_bytes(
			"x-special/gnome-copied-files",
			string_to_bytes(payload.gnome_payload),
		),
	])
}

export async function write_clipboard_file_payload(
	operation: clipboard_operation,
	paths: string[],
): Promise<Result<void>> {
	if (paths.length === 0) return ok(undefined)

	const display = Gdk.Display.get_default()
	if (display) {
		const result = attempt(() =>
			display
				.get_clipboard()
				.set_content(build_file_content_provider(paths, operation)),
		)
		if (!result.ok)
			return err(
				new Error("Failed to write desktop clipboard payload", {
					cause: result.err,
				}),
			)
		if (!result.value)
			return err(new Error("Failed to write desktop clipboard payload"))
		return ok(undefined)
	}

	const payload = serialize_clipboard_file_payload(paths, operation)
	const primary = await attempt_async(async () =>
		execAsync([
			"setsid",
			"-f",
			"wl-copy",
			"-t",
			"x-special/gnome-copied-files",
			payload.gnome_payload,
		]),
	)
	if (primary.ok) return ok(undefined)

	const fallback = await attempt_async(async () =>
		execAsync([
			"setsid",
			"-f",
			"wl-copy",
			"-t",
			"text/uri-list",
			payload.uri_list,
		]),
	)
	if (fallback.ok) return ok(undefined)

	return err(
		new Error("Failed to write desktop clipboard payload", {
			cause: { primary_error: primary.err, fallback_error: fallback.err },
		}),
	)
}

export async function clear_clipboard_file_payload(): Promise<Result<void>> {
	const display = Gdk.Display.get_default()
	if (display) {
		const result = attempt(() => display.get_clipboard().set_content(null))
		if (!result.ok)
			return err(
				new Error("Failed to clear desktop clipboard payload", {
					cause: result.err,
				}),
			)
		return result.value
			? ok(undefined)
			: err(new Error("Failed to clear desktop clipboard payload"))
	}

	const result = await attempt_async(async () =>
		execAsync(["wl-copy", "--clear"]),
	)
	return result.ok
		? ok(undefined)
		: err(
				new Error("Failed to clear desktop clipboard payload", {
					cause: result.err,
				}),
			)
}

async function read_clipboard_mime(mime_type: string) {
	return execAsync(["wl-paste", "-t", mime_type]).catch(() => null)
}

export function paths_from_uris(uris: string[]): string[] {
	const paths: string[] = []
	for (const uri of uris) {
		if (!uri.startsWith("file://")) continue
		const result = attempt(() => Gio.File.new_for_uri(uri).get_path())
		if (!log_error(result, "desktop.fileUris: Invalid local file URI")) continue
		if (result.value && GLib.path_is_absolute(result.value))
			paths.push(result.value)
	}
	return paths
}

export async function read_file_text(
	stream: Gio.InputStream,
	cancellable: Gio.Cancellable | null = null,
): Promise<string> {
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		for (;;) {
			const bytes = await stream.read_bytes_async(
				8192,
				GLib.PRIORITY_DEFAULT,
				cancellable,
			)
			const chunk = bytes.get_data()
			if (!chunk?.length) break
			size += chunk.length
			if (size > 1024 * 1024) throw new Error("File URI list exceeds 1 MiB")
			chunks.push(chunk)
		}
	} finally {
		if (!(await stream.close_async(GLib.PRIORITY_DEFAULT, null)))
			throw new Error("Failed to close file URI stream")
	}
	const data = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		data.set(chunk, offset)
		offset += chunk.length
	}
	return new TextDecoder().decode(data)
}

export function split_payload_lines(text: string): string[] {
	return text
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.filter(Boolean)
}

export async function read_clipboard_file_payload(): Promise<ClipboardFilePayload | null> {
	const clipboard = Gdk.Display.get_default()?.get_clipboard()
	let copied_files: string | null = null
	let uri_list: string | null = null
	if (clipboard) {
		const formats = clipboard.get_formats()
		const mime_types = ["x-special/gnome-copied-files", "text/uri-list"]
		if (!mime_types.some((mime) => formats.contain_mime_type(mime))) return null
		const cancellable = new Gio.Cancellable()
		const deadline = timeout(30_000, () => cancellable.cancel())
		try {
			const [stream, mime] = await clipboard.read_async(
				mime_types,
				GLib.PRIORITY_DEFAULT,
				cancellable,
			)
			if (!stream) throw new Error("Clipboard provided no stream")
			const text = await read_file_text(stream, cancellable)
			if (mime === mime_types[0]) copied_files = text
			else uri_list = text
		} catch (error) {
			console.error("desktop.clipboard: Failed to read clipboard", error)
			return null
		} finally {
			deadline.cancel()
		}
	} else {
		copied_files = await read_clipboard_mime("x-special/gnome-copied-files")
		if (!copied_files) uri_list = await read_clipboard_mime("text/uri-list")
	}
	if (copied_files) {
		const lines = split_payload_lines(copied_files)
		const files = paths_from_uris(lines.slice(1))
		if (files.length > 0) {
			let operation: clipboard_operation = "copy"
			if (lines[0] === "cut") operation = "cut"
			return { operation, files }
		}
	}

	if (!uri_list) return null

	const files = paths_from_uris(
		split_payload_lines(uri_list).filter((line) => !line.startsWith("#")),
	)
	if (files.length === 0) return null
	return { operation: "copy", files }
}
