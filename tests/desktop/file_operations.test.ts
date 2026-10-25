import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as result_module from "../../lib/result.ts"

type transfer_hook = (source: string, target: string) => void
type info_override = {
	content_type?: string | null
	icon_names?: string[]
	modified?: number
}
type launcher_spec = {
	icon_names: string[] | null
	icon_value: string | null
	display_name: string
	name: string
} | null

const files = new Map<string, string | undefined>()
const attributes = new Map<string, Record<string, string | boolean>>()
const infos = new Map<string, info_override>()
const launchers = new Map<string, launcher_spec>()
let before_copy: transfer_hook | null = null
let before_move: transfer_hook | null = null
const outcomes = {
	finish: true,
	close_directory: true,
	trash: true,
	close_stream: true,
	trusted: true,
	launch: true,
	make_directory: true,
	next_files: true,
	display: true,
	set_content: true as boolean | "throw",
}
let clipboard_stream: unknown = null
let clipboard_mime = "text/uri-list"
const clipboard_contents: unknown[] = []
const timeouts: { ms: number; cancelled: boolean }[] = []
const launched: string[] = []

class io_error extends Error {
	declare code: string
	constructor(code: string) {
		super(code)
		this.code = code
	}
	matches(_domain, code) {
		return this.code === code
	}
}

function file_info(path: string) {
	const override = infos.get(path) ?? {}
	let content_type: string | null = "application/x-desktop"
	if ("content_type" in override) content_type = override.content_type ?? null
	return {
		get_name: () => path.split("/").pop(),
		get_file_type: () => files.get(path),
		get_content_type: () => content_type,
		get_modification_date_time: () =>
			override.modified === undefined
				? null
				: { to_unix: () => override.modified },
		get_icon: () =>
			override.icon_names ? { get_names: () => override.icon_names } : null,
		get_attribute_string: (name) => attributes.get(path)?.[name] ?? null,
		get_attribute_boolean: (name) => attributes.get(path)?.[name] === true,
	}
}

class mock_file {
	declare path: string
	constructor(path: string) {
		this.path = path
	}
	get_path() {
		return this.path
	}
	get_basename() {
		return this.path.split("/").pop()
	}
	get_parent() {
		return new mock_file(this.path.slice(0, this.path.lastIndexOf("/")))
	}
	get_child(name) {
		return new mock_file(`${this.path}/${name}`)
	}
	equal(other) {
		return this.path === other.path
	}
	has_prefix(other) {
		return this.path.startsWith(`${other.path}/`)
	}
	query_info_async() {
		if (!files.has(this.path)) return Promise.reject(new io_error("NOT_FOUND"))
		return Promise.resolve({ get_file_type: () => files.get(this.path) })
	}
	enumerate_children_async() {
		if (files.get(this.path) !== "directory")
			return Promise.reject(new io_error("NOT_FOUND"))
		const names = [...files.keys()].filter(
			(path) =>
				path.startsWith(`${this.path}/`) &&
				!path.slice(this.path.length + 1).includes("/"),
		)
		let offset = 0
		return Promise.resolve({
			next_files_async: async (count) => {
				if (!outcomes.next_files) throw new io_error("FAILED")
				return names.slice(offset, (offset += count)).map(file_info)
			},
			close_async: async () => outcomes.close_directory,
		})
	}
	make_directory_async() {
		if (files.has(this.path)) return Promise.reject(new io_error("EXISTS"))
		files.set(this.path, "directory")
		return Promise.resolve(true)
	}
	copy_async(target, _flags, _priority, _cancellable, _progress, callback) {
		queueMicrotask(() => {
			before_copy?.(this.path, target.path)
			let error: io_error | null = null
			if (!files.has(this.path)) error = new io_error("NOT_FOUND")
			else if (files.has(target.path)) error = new io_error("EXISTS")
			else files.set(target.path, files.get(this.path))
			callback(this, { error })
		})
	}
	copy_finish(result) {
		if (result.error) throw result.error
		return outcomes.finish
	}
	move_async(target, _flags, _priority, _cancellable, _progress, callback) {
		queueMicrotask(() => {
			before_move?.(this.path, target.path)
			let error: io_error | null = null
			if (!files.has(this.path)) {
				error = new io_error("NOT_FOUND")
			} else if (files.has(target.path)) {
				error = new io_error("EXISTS")
			} else if (files.get(this.path) === "directory") {
				error = new io_error("WOULD_RECURSE")
			} else {
				files.set(target.path, files.get(this.path))
				files.delete(this.path)
			}
			callback(this, { error })
		})
	}
	move_finish(result) {
		if (result.error) throw result.error
		return true
	}
	delete_async() {
		if (!files.has(this.path)) return Promise.reject(new io_error("NOT_FOUND"))
		if (
			files.get(this.path) === "directory" &&
			[...files.keys()].some((path) => path.startsWith(`${this.path}/`))
		)
			return Promise.reject(new io_error("NOT_EMPTY"))
		files.delete(this.path)
		return Promise.resolve(true)
	}
	trash_async() {
		if (outcomes.trash) files.delete(this.path)
		return Promise.resolve(outcomes.trash)
	}
	query_exists() {
		return files.has(this.path)
	}
	make_directory() {
		if (files.has(this.path)) throw new io_error("EXISTS")
		if (outcomes.make_directory) files.set(this.path, "directory")
		return outcomes.make_directory
	}
	create() {
		if (files.has(this.path)) throw new io_error("EXISTS")
		files.set(this.path, "")
		const path = this.path
		return {
			write_all: (bytes) => {
				files.set(path, new TextDecoder().decode(bytes))
				return [true, bytes.length]
			},
			close: () => outcomes.close_stream,
		}
	}
	set_attribute_uint32() {
		return true
	}
	set_attribute_string() {
		return outcomes.trusted
	}
	delete() {
		files.delete(this.path)
		return true
	}
	query_info() {
		const path = this.path
		return {
			get_attribute_string: (name) => attributes.get(path)?.[name] ?? null,
			get_attribute_boolean: (name) => attributes.get(path)?.[name] === true,
		}
	}
	get_uri() {
		return `file://${this.path}`
	}
	move(target) {
		if (files.has(target.path)) throw new io_error("EXISTS")
		if (!outcomes.finish) return false
		files.set(target.path, files.get(this.path))
		files.delete(this.path)
		return true
	}
}

const gio = {
	File: {
		new_for_path: (path) => new mock_file(path),
		new_for_uri: (uri) => {
			const url = new URL(uri)
			return new mock_file(url.host ? "" : decodeURIComponent(url.pathname))
		},
	},
	FileCopyFlags: { NONE: 0, NOFOLLOW_SYMLINKS: 1 },
	FileCreateFlags: { NONE: 0 },
	Cancellable: class {
		cancel() {}
	},
	app_info_launch_default_for_uri: (uri) => {
		launched.push(uri)
		return outcomes.launch
	},
	FileQueryInfoFlags: { NONE: 0, NOFOLLOW_SYMLINKS: 1 },
	FileType: { DIRECTORY: "directory" },
	IOErrorEnum: { EXISTS: "EXISTS", WOULD_RECURSE: "WOULD_RECURSE" },
	io_error_quark: () => "gio",
	content_type_get_icon: (type) => {
		if (type === "broken/type") throw new io_error("FAILED")
		return { get_names: () => [type.replace("/", "-")] }
	},
	content_type_guess: (path) => [path.endsWith(".png") ? "image/png" : null],
}
class key_file {
	declare lines: string[]
	constructor() {
		this.lines = ["[Desktop Entry]"]
	}
	set_string(_group, key, value) {
		this.lines.push(`${key}=${value}`)
	}
	set_boolean(_group, key, value) {
		this.lines.push(`${key}=${value}`)
	}
	to_data() {
		return [this.lines.join("\n"), 0]
	}
}
const glib = {
	Error: io_error,
	KeyFile: key_file,
	PRIORITY_DEFAULT: 0,
	UserDirectory: { DIRECTORY_DESKTOP: 0 },
	get_user_special_dir: () => "/home/test/Desktop",
	get_home_dir: () => "/home/test",
	path_is_absolute: (path) => path.startsWith("/"),
}
const default_launcher: launcher_spec = {
	icon_names: ["application-pdf"],
	icon_value: null,
	display_name: "invoice.pdf",
	name: "invoice.pdf",
}

const clipboard = {
	get_formats: () => ({
		contain_mime_type: (mime) => mime === clipboard_mime,
	}),
	read_async: async () => [clipboard_stream, clipboard_mime],
	set_content: (content) => {
		if (outcomes.set_content === "throw") throw new io_error("FAILED")
		clipboard_contents.push(content)
		return outcomes.set_content
	},
}

const imports = {
	"gi://Gio": { default: gio },
	"gi://GioUnix": {
		default: {
			DesktopAppInfo: {
				new_from_filename: (path) => {
					const spec = launchers.has(path)
						? launchers.get(path)
						: default_launcher
					if (!spec) return null
					return {
						get_icon: () =>
							spec.icon_names ? { get_names: () => spec.icon_names } : null,
						get_string: () => spec.icon_value,
						get_display_name: () => {
							if (spec.display_name === "throw") throw new io_error("FAILED")
							return spec.display_name
						},
						get_name: () => spec.name,
						launch: () => {
							launched.push("launcher")
							return outcomes.launch
						},
					}
				},
			},
		},
	},
	"gi://GLib": { default: glib },
	"ags/gtk4": {
		Gdk: {
			Display: {
				get_default: () =>
					outcomes.display ? { get_clipboard: () => clipboard } : null,
			},
			FileList: {
				new_from_array: (files) => ({ files: files.map((file) => file.path) }),
			},
			ContentProvider: {
				new_union: (providers) => ({ union: providers }),
				new_for_value: (value) => ({ value }),
				new_for_bytes: (mime, bytes) => ({
					mime,
					text: new TextDecoder().decode(bytes),
				}),
			},
		},
	},
	"$lib/time": {
		timeout: (ms) => {
			const entry = { ms, cancelled: false }
			timeouts.push(entry)
			return {
				cancel: () => {
					entry.cancelled = true
				},
			}
		},
	},
	"$lib/result": result_module,
}
imports["$lib/files"] = await load_module("lib/files.ts", imports)
const {
	transfer_desktop_files,
	rename_file,
	delete_desktop_files,
	create_desktop_folder,
	create_desktop_text_file,
	create_desktop_launcher,
	open_path,
	load_desktop_files,
	read_file_text,
	read_clipboard_file_payload,
	paths_from_uris,
	uri_list_paths,
	build_file_content_provider,
	write_clipboard_file_payload,
	clear_clipboard_file_payload,
} = (await load_module(
	"widget/Desktop/file_operations.ts",
	imports,
)) as typeof import("../../widget/Desktop/file_operations.ts")

function reset() {
	files.clear()
	attributes.clear()
	infos.clear()
	launchers.clear()
	clipboard_contents.length = 0
	timeouts.length = 0
	clipboard_mime = "text/uri-list"
	files.set("/home/test/Desktop", "directory")
	before_copy = null
	before_move = null
	launched.length = 0
	clipboard_stream = null
	for (const key of Object.keys(outcomes)) outcomes[key] = true
}

function failure_message(result) {
	assert.equal(result.failures.length, 1)
	return String(result.failures[0].error)
}

function error_chain(result): string[] {
	assert.equal(result.ok, false)
	const messages: string[] = []
	for (let error = result.err; error; error = error.cause)
		messages.push(error.message)
	return messages
}

test("copy collision retries the actual no-clobber operation", async () => {
	reset()
	files.set("/home/test/Downloads/a.txt", "file")
	before_copy = (_source, target) => {
		if (target === "/home/test/Desktop/a.txt") files.set(target, "rival")
	}
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/a.txt"],
		operation: "copy",
	})
	assert.deepEqual(result.failures, [])
	assert.deepEqual(result.created_paths, ["/home/test/Desktop/a (1).txt"])
	assert.equal(files.get("/home/test/Desktop/a.txt"), "rival")
	assert.equal(files.get("/home/test/Downloads/a.txt"), "file")
})

test("concurrent moves of matching names keep both sources' contents", async () => {
	reset()
	files.set("/home/test/one/same.txt", "first")
	files.set("/home/test/two/same.txt", "second")
	const results = await Promise.all([
		transfer_desktop_files({
			paths: ["/home/test/one/same.txt"],
			operation: "move",
		}),
		transfer_desktop_files({
			paths: ["/home/test/two/same.txt"],
			operation: "move",
		}),
	])
	assert.ok(results.every((result) => result.failures.length === 0))
	assert.deepEqual(
		new Set(results.flatMap((result) => result.created_paths)),
		new Set(["/home/test/Desktop/same.txt", "/home/test/Desktop/same (1).txt"]),
	)
	assert.deepEqual(
		new Set([
			files.get("/home/test/Desktop/same.txt"),
			files.get("/home/test/Desktop/same (1).txt"),
		]),
		new Set(["first", "second"]),
	)
})

test("directory move transfers enumerated children then removes the empty source", async () => {
	reset()
	files.set("/home/test/Downloads/folder", "directory")
	files.set("/home/test/Downloads/folder/inside", "file")
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/folder", "/home/test/Downloads/missing"],
		operation: "move",
	})
	assert.deepEqual(result.created_paths, ["/home/test/Desktop/folder"])
	assert.equal(result.failures.length, 1)
	assert.equal(files.get("/home/test/Desktop/folder/inside"), "file")
	assert.equal(files.has("/home/test/Downloads/folder"), false)
	assert.equal(files.has("/home/test/Downloads/missing"), false)
})

test("directory move preserves files created after enumeration and reports the partial destination", async () => {
	reset()
	files.set("/home/test/Downloads/folder", "directory")
	files.set("/home/test/Downloads/folder/inside", "file")
	const add_late_file = (source) => {
		if (source === "/home/test/Downloads/folder/inside")
			files.set("/home/test/Downloads/folder/late", "late")
	}
	before_copy = add_late_file
	before_move = add_late_file
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/folder"],
		operation: "move",
	})
	assert.deepEqual(result.created_paths, [])
	assert.equal(result.failures.length, 1)
	assert.equal(result.failures[0].destination, "/home/test/Desktop/folder")
	assert.equal(files.get("/home/test/Desktop/folder/inside"), "file")
	assert.equal(files.get("/home/test/Downloads/folder/late"), "late")
	assert.equal(files.get("/home/test/Downloads/folder"), "directory")
})

test("nested late arrival keeps both source directories and records the top-level destination", async () => {
	reset()
	files.set("/home/test/Downloads/folder", "directory")
	files.set("/home/test/Downloads/folder/sub", "directory")
	files.set("/home/test/Downloads/folder/sub/inside", "file")
	before_move = (source) => {
		if (source === "/home/test/Downloads/folder/sub/inside")
			files.set("/home/test/Downloads/folder/sub/late", "late")
	}
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/folder"],
		operation: "move",
	})
	assert.deepEqual(result.created_paths, [])
	assert.equal(result.failures[0].destination, "/home/test/Desktop/folder")
	assert.equal(files.get("/home/test/Desktop/folder/sub/inside"), "file")
	assert.equal(files.get("/home/test/Downloads/folder/sub/late"), "late")
	assert.equal(files.get("/home/test/Downloads/folder/sub"), "directory")
	assert.equal(files.get("/home/test/Downloads/folder"), "directory")
})

test("child collision during a move preserves the untransferred child and rival", async () => {
	reset()
	files.set("/home/test/Downloads/folder", "directory")
	files.set("/home/test/Downloads/folder/a", "first")
	files.set("/home/test/Downloads/folder/b", "second")
	before_move = (source, target) => {
		if (source === "/home/test/Downloads/folder/b") files.set(target, "rival")
	}
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/folder"],
		operation: "move",
	})
	assert.deepEqual(result.created_paths, [])
	assert.equal(result.failures[0].destination, "/home/test/Desktop/folder")
	assert.equal(files.get("/home/test/Desktop/folder/a"), "first")
	assert.equal(files.get("/home/test/Desktop/folder/b"), "rival")
	assert.equal(files.get("/home/test/Downloads/folder/b"), "second")
	assert.equal(files.get("/home/test/Downloads/folder"), "directory")
})

test("failed directory copy preserves other writers' files and the source", async () => {
	reset()
	files.set("/home/test/Downloads/folder", "directory")
	files.set("/home/test/Downloads/folder/inside", "file")
	before_copy = (_source, target) => {
		if (target === "/home/test/Desktop/folder/inside")
			files.set(target, "rival")
	}
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/folder"],
		operation: "copy",
	})
	assert.deepEqual(result.created_paths, [])
	assert.match(
		String(result.failures[0].error),
		/Incomplete copy at \/home\/test\/Desktop\/folder/,
	)
	assert.equal(files.get("/home/test/Desktop/folder/inside"), "rival")
	assert.equal(files.get("/home/test/Downloads/folder/inside"), "file")
})

test("rename rejects path traversal without touching files", () => {
	reset()
	files.set("/home/test/Desktop/item", "file")
	for (const name of ["../outside", "/tmp/outside", ".", "..", "a\0b"])
		assert.equal(rename_file("/home/test/Desktop/item", name).ok, false)
	assert.equal(files.get("/home/test/Desktop/item"), "file")
})

test("permanent removal refuses files outside the Desktop", async () => {
	reset()
	files.set("/home/test/Downloads/item", "file")
	const result = await delete_desktop_files({
		paths: ["/home/test/Downloads/item"],
		operation: "delete",
	})
	assert.deepEqual(result.removed_paths, [])
	assert.equal(result.failures.length, 1)
	assert.equal(files.get("/home/test/Downloads/item"), "file")
})

test("desktop entries show their Name and Icon only when trusted and executable", async () => {
	reset()
	files.set("/home/test/Desktop/untrusted.desktop", "file")
	files.set("/home/test/Desktop/not-executable.desktop", "file")
	files.set("/home/test/Desktop/trusted.desktop", "file")
	attributes.set("/home/test/Desktop/not-executable.desktop", {
		"metadata::trusted": "true",
		"access::can-execute": false,
	})
	attributes.set("/home/test/Desktop/trusted.desktop", {
		"metadata::trusted": "true",
		"access::can-execute": true,
	})
	const result = await load_desktop_files()
	assert.ok(result.ok)
	const by_name = new Map(result.value.map((file) => [file.name, file]))
	for (const name of ["untrusted.desktop", "not-executable.desktop"]) {
		assert.equal(by_name.get(name)?.display_name, undefined)
		assert.equal(by_name.get(name)?.icon, "application-x-desktop")
	}
	assert.equal(by_name.get("trusted.desktop")?.display_name, "invoice.pdf")
	assert.equal(by_name.get("trusted.desktop")?.icon, "application-pdf")
})

test("file URI parsing rejects nonlocal and non-file URI payloads", () => {
	assert.deepEqual(
		paths_from_uris([
			"file:///home/test/a%20b",
			"https://example.org/item",
			"file://remote/share",
		]),
		["/home/test/a b"],
	)
})

test("file URI streams are bounded and closed even on rejection", async () => {
	let closed = false
	let reads = 0
	const stream = {
		read_bytes_async: async () => ({
			get_data: () =>
				reads++ ? new Uint8Array(2) : new Uint8Array(1024 * 1024),
		}),
		close_async: async () => {
			closed = true
			return true
		},
	}
	const read = await read_file_text(
		stream as unknown as Parameters<typeof read_file_text>[0],
	)
	assert.equal(read.ok, false)
	assert.match(String(!read.ok && read.err), /exceeds 1 MiB/)
	assert.equal(closed, true)
})

test("transfer rejects unusable sources and skips moving a desktop item onto itself", async () => {
	reset()
	files.set("/home/test/Desktop/here.txt", "file")
	const rejected = await transfer_desktop_files({
		paths: ["", "relative/a.txt", "/home/test/Desktop"],
		operation: "copy",
	})
	assert.deepEqual(rejected.created_paths, [])
	assert.deepEqual(
		rejected.failures.map((failure) => String(failure.error)),
		[
			"Error: Source path is empty",
			"Error: Source must be an absolute local path",
			"Error: Cannot transfer a directory into itself",
		],
	)
	const skipped = await transfer_desktop_files({
		paths: ["/home/test/Desktop/here.txt"],
		operation: "move",
	})
	assert.deepEqual(skipped, { created_paths: [], failures: [] })
	assert.equal(files.get("/home/test/Desktop/here.txt"), "file")
})

test("failed single-file copy reports where an incomplete copy may remain", async () => {
	reset()
	files.set("/home/test/Downloads/a.txt", "file")
	before_copy = (source) => files.delete(source)
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/a.txt"],
		operation: "copy",
	})
	assert.match(
		failure_message(result),
		/Incomplete copy may remain at \/home\/test\/Desktop\/a\.txt/,
	)
	assert.equal(result.failures[0].destination, "/home/test/Desktop/a.txt")
	const error = result.failures[0].error as Error
	assert.equal((error.cause as io_error).code, "NOT_FOUND")
})

test("copy that finishes with false is a failure, not a success", async () => {
	reset()
	files.set("/home/test/Downloads/a.txt", "file")
	outcomes.finish = false
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/a.txt"],
		operation: "copy",
	})
	assert.deepEqual(result.created_paths, [])
	const error = result.failures[0].error as Error
	assert.equal(String(error.cause), "Error: Copy returned false")
})

test("permanent removal deletes desktop directories recursively and trash reports refusals", async () => {
	reset()
	files.set("/home/test/Desktop/folder", "directory")
	files.set("/home/test/Desktop/folder/sub", "directory")
	files.set("/home/test/Desktop/folder/sub/inside", "file")
	const deleted = await delete_desktop_files({
		paths: ["/home/test/Desktop/folder"],
		operation: "delete",
	})
	assert.deepEqual(deleted, {
		removed_paths: ["/home/test/Desktop/folder"],
		failures: [],
	})
	assert.deepEqual([...files.keys()], ["/home/test/Desktop"])

	files.set("/home/test/Desktop/item", "file")
	outcomes.trash = false
	const trashed = await delete_desktop_files({
		paths: ["/home/test/Desktop/item"],
		operation: "trash",
	})
	assert.deepEqual(trashed.removed_paths, [])
	assert.equal(failure_message(trashed), "Error: Trash returned false")
	assert.equal(files.get("/home/test/Desktop/item"), "file")
})

test("a directory that fails to close stops its removal", async () => {
	reset()
	files.set("/home/test/Desktop/folder", "directory")
	files.set("/home/test/Desktop/folder/inside", "file")
	outcomes.close_directory = false
	const result = await delete_desktop_files({
		paths: ["/home/test/Desktop/folder"],
		operation: "delete",
	})
	assert.equal(
		failure_message(result),
		"Error: Failed to close directory /home/test/Desktop/folder",
	)
	assert.equal(files.get("/home/test/Desktop/folder"), "directory")
	assert.equal(files.has("/home/test/Desktop/folder/inside"), false)
})

test("a child failure outranks the directory close failure", async () => {
	reset()
	files.set("/home/test/Downloads/folder", "directory")
	files.set("/home/test/Downloads/folder/inside", "file")
	before_copy = (_source, target) => files.set(target, "rival")
	outcomes.close_directory = false
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/folder"],
		operation: "copy",
	})
	assert.match(failure_message(result), /Incomplete copy at/)
	const error = result.failures[0].error as Error
	assert.equal((error.cause as io_error).code, "EXISTS")
})

test("rename moves to a free name, keeps an unchanged name and refuses an existing target", () => {
	reset()
	files.set("/home/test/Desktop/item", "file")
	files.set("/home/test/Desktop/taken", "rival")
	assert.deepEqual(rename_file("/home/test/Desktop/item", "item"), {
		ok: true,
		value: "/home/test/Desktop/item",
	})
	assert.deepEqual(
		error_chain(rename_file("/home/test/Desktop/item", "taken")),
		[
			"Failed to rename /home/test/Desktop/item",
			"Target already exists: /home/test/Desktop/taken",
		],
	)
	assert.deepEqual(rename_file("/home/test/Desktop/item", "renamed"), {
		ok: true,
		value: "/home/test/Desktop/renamed",
	})
	assert.equal(files.get("/home/test/Desktop/renamed"), "file")
	assert.equal(files.get("/home/test/Desktop/taken"), "rival")
})

test("new folders and text files take the next free name and fail on a false close", () => {
	reset()
	files.set("/home/test/Desktop/New Folder", "directory")
	assert.deepEqual(create_desktop_folder(), {
		ok: true,
		value: "/home/test/Desktop/New Folder 1",
	})
	assert.deepEqual(create_desktop_text_file(), {
		ok: true,
		value: "/home/test/Desktop/New Text File.txt",
	})
	outcomes.close_stream = false
	assert.deepEqual(error_chain(create_desktop_text_file()), [
		"Failed to create desktop text file",
		"Text file close returned false",
	])
})

test("launcher creation validates input and removes an incomplete launcher", () => {
	reset()
	assert.deepEqual(
		error_chain(create_desktop_launcher({ name: " ", command: "app" })),
		["Failed to create desktop launcher", "Launcher name is required"],
	)
	assert.deepEqual(
		error_chain(create_desktop_launcher({ name: "App", command: " " })),
		["Failed to create desktop launcher", "Launcher command is required"],
	)
	outcomes.trusted = false
	assert.deepEqual(
		error_chain(create_desktop_launcher({ name: "My App", command: "app" })),
		["Failed to create desktop launcher", "Could not mark launcher as trusted"],
	)
	assert.equal(files.has("/home/test/Desktop/My-App.desktop"), false)

	outcomes.trusted = true
	assert.deepEqual(
		create_desktop_launcher({ name: "My App", command: "app" }),
		{
			ok: true,
			value: "/home/test/Desktop/My-App.desktop",
		},
	)
	assert.match(
		String(files.get("/home/test/Desktop/My-App.desktop")),
		/Exec=app/,
	)
})

test("opening refuses untrusted desktop entries and reports a refusing default app", () => {
	reset()
	assert.deepEqual(error_chain(open_path("/home/test/Desktop/evil.desktop")), [
		"Failed to open /home/test/Desktop/evil.desktop",
		"Refusing to launch an untrusted desktop entry",
	])
	assert.deepEqual(open_path("/home/test/Desktop/a.txt"), {
		ok: true,
		value: undefined,
	})
	outcomes.launch = false
	assert.deepEqual(error_chain(open_path("/home/test/Desktop/a.txt")), [
		"Failed to open /home/test/Desktop/a.txt",
		"Default application returned false",
	])
	assert.deepEqual(launched, [
		"file:///home/test/Desktop/a.txt",
		"file:///home/test/Desktop/a.txt",
	])
})

test("transfer gives up after exhausting destination names", async () => {
	reset()
	files.set("/home/test/Downloads/a.txt", "file")
	before_copy = (_source, target) => files.set(target, "rival")
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/a.txt"],
		operation: "copy",
	})
	assert.equal(failure_message(result), "Error: No available destination name")
	assert.equal(files.get("/home/test/Desktop/a (9999).txt"), "rival")
})

test("a failed directory read reports the close failure ahead of the read failure", async () => {
	reset()
	files.set("/home/test/Desktop/folder", "directory")
	outcomes.next_files = false
	const unread = await delete_desktop_files({
		paths: ["/home/test/Desktop/folder"],
		operation: "delete",
	})
	assert.equal(failure_message(unread), "Error: FAILED")
	outcomes.close_directory = false
	const unclosed = await delete_desktop_files({
		paths: ["/home/test/Desktop/folder"],
		operation: "delete",
	})
	assert.equal(
		failure_message(unclosed),
		"Error: Failed to close directory /home/test/Desktop/folder",
	)
	assert.equal(files.get("/home/test/Desktop/folder"), "directory")
})

test("rename and folder creation report a false result from GIO", () => {
	reset()
	files.set("/home/test/Desktop/item", "file")
	outcomes.finish = false
	assert.deepEqual(
		error_chain(rename_file("/home/test/Desktop/item", "renamed")),
		["Failed to rename /home/test/Desktop/item", "Rename returned false"],
	)
	assert.equal(files.get("/home/test/Desktop/item"), "file")
	outcomes.make_directory = false
	assert.deepEqual(error_chain(create_desktop_folder()), [
		"Failed to create desktop folder",
		"Folder creation returned false",
	])
})

test("an incomplete launcher is closed and removed, logging a refused close", (t) => {
	reset()
	const logged = t.mock.method(console, "error", () => {})
	outcomes.close_stream = false
	assert.deepEqual(
		error_chain(create_desktop_launcher({ name: "App", command: "app" })),
		["Failed to create desktop launcher", "Launcher close returned false"],
	)
	assert.equal(files.has("/home/test/Desktop/App.desktop"), false)
	assert.deepEqual(
		logged.mock.calls.map((call) => call.arguments),
		[
			[
				"desktop.create_launcher: Failed to close /home/test/Desktop/App.desktop",
				"close returned false",
			],
		],
	)
})

test("trusted desktop entries launch through their launcher", () => {
	reset()
	attributes.set("/home/test/Desktop/app.desktop", {
		"metadata::trusted": "true",
		"access::can-execute": true,
	})
	assert.deepEqual(open_path("/home/test/Desktop/app.desktop"), {
		ok: true,
		value: undefined,
	})
	outcomes.launch = false
	assert.deepEqual(error_chain(open_path("/home/test/Desktop/app.desktop")), [
		"Failed to open /home/test/Desktop/app.desktop",
		"Launcher returned false",
	])
	assert.deepEqual(launched, ["launcher", "launcher"])
})

test("clipboard payload reads a uri list and yields nothing without a stream", async (t) => {
	reset()
	const logged = t.mock.method(console, "error", () => {})
	assert.equal(await read_clipboard_file_payload(), null)
	let reads = 0
	const uri_list = new TextEncoder().encode("file:///home/test/a\r\n")
	clipboard_stream = {
		read_bytes_async: async () => ({
			get_data: () => (reads++ ? null : uri_list),
		}),
		close_async: async () => true,
	}
	assert.deepEqual(await read_clipboard_file_payload(), {
		operation: "copy",
		paths: ["/home/test/a"],
	})
	clipboard_stream = {
		read_bytes_async: async () => {
			throw new io_error("FAILED")
		},
		close_async: async () => true,
	}
	assert.equal(await read_clipboard_file_payload(), null)
	assert.deepEqual(
		logged.mock.calls.map((call) => call.arguments[0]),
		[
			"desktop.clipboard: Failed to read clipboard",
			"desktop.clipboard: Failed to read clipboard",
		],
	)
})

test("directory copy onto a taken desktop name moves on to the next free name", async () => {
	reset()
	files.set("/home/test/Downloads/folder", "directory")
	files.set("/home/test/Downloads/folder/inside", "file")
	files.set("/home/test/Desktop/folder", "directory")
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/folder"],
		operation: "copy",
	})
	assert.deepEqual(result, {
		created_paths: ["/home/test/Desktop/folder (1)"],
		failures: [],
	})
	assert.equal(files.has("/home/test/Desktop/folder/inside"), false)
	assert.equal(files.get("/home/test/Desktop/folder (1)/inside"), "file")
})

test("reading a URI list reports a failed close ahead of a failed read", async () => {
	const stream = (read_fails: boolean, closes: boolean) => ({
		read_bytes_async: async () => {
			if (read_fails) throw new Error("read failed")
			return { get_data: () => new Uint8Array(0) }
		},
		close_async: async () => closes,
	})
	const read = (s) =>
		read_file_text(s as unknown as Parameters<typeof read_file_text>[0])
	const both = await read(stream(true, false))
	assert.match(String(!both.ok && both.err), /Failed to close file URI stream/)
	const read_only = await read(stream(true, true))
	assert.match(String(!read_only.ok && read_only.err), /read failed/)
	const clean = await read(stream(false, true))
	assert.deepEqual(clean, { ok: true, value: "" })
})

test("desktop listing sorts folders first, hides dotfiles and resolves types, icons and dates", async () => {
	reset()
	files.set("/home/test/Desktop/zeta", "directory")
	files.set("/home/test/Desktop/.hidden", "file")
	files.set("/home/test/Desktop/b.txt", "file")
	files.set("/home/test/Desktop/a.png", "file")
	files.set("/home/test/Desktop/c.bin", "file")
	files.set("/home/test/Desktop/d.odd", "file")
	infos.set("/home/test/Desktop/b.txt", {
		content_type: "text/plain",
		icon_names: ["own-icon"],
		modified: 5,
	})
	infos.set("/home/test/Desktop/a.png", { content_type: "" })
	infos.set("/home/test/Desktop/c.bin", { content_type: null })
	infos.set("/home/test/Desktop/d.odd", { content_type: "broken/type" })
	const listed = await load_desktop_files()
	assert.ok(listed.ok)
	assert.deepEqual(
		listed.value.map((file) => [
			file.name,
			file.content_type,
			file.icon,
			file.modified?.getTime(),
		]),
		[
			["zeta", "inode/directory", "application-x-desktop", 0],
			["a.png", "image/png", "text-x-generic", 0],
			["b.txt", "text/plain", "own-icon", 5000],
			["c.bin", "application/octet-stream", "text-x-generic", 0],
			["d.odd", "broken/type", "text-x-generic", 0],
		],
	)
	assert.equal(listed.value[0].path, "/home/test/Desktop/zeta")
})

test("trusted desktop entries resolve themed, relative and absolute icons", async () => {
	reset()
	const trusted = { "metadata::trusted": "true", "access::can-execute": true }
	for (const name of ["themed", "relative", "absolute", "broken"]) {
		files.set(`/home/test/Desktop/${name}.desktop`, "file")
		attributes.set(`/home/test/Desktop/${name}.desktop`, trusted)
	}
	launchers.set("/home/test/Desktop/relative.desktop", {
		icon_names: null,
		icon_value: "my-icon",
		display_name: "",
		name: "Relative",
	})
	launchers.set("/home/test/Desktop/absolute.desktop", {
		icon_names: null,
		icon_value: "/icons/app.png",
		display_name: "Absolute",
		name: "ignored",
	})
	launchers.set("/home/test/Desktop/broken.desktop", null)
	files.set("/home/test/Desktop/throws.desktop", "file")
	attributes.set("/home/test/Desktop/throws.desktop", trusted)
	launchers.set("/home/test/Desktop/throws.desktop", {
		icon_names: ["unused"],
		icon_value: null,
		display_name: "throw",
		name: "unused",
	})
	const listed = await load_desktop_files()
	assert.ok(listed.ok)
	assert.deepEqual(
		listed.value.map((file) => [
			file.name,
			file.display_name,
			file.icon,
			file.icon_file,
		]),
		[
			[
				"absolute.desktop",
				"Absolute",
				"application-x-desktop",
				"/icons/app.png",
			],
			["broken.desktop", undefined, "application-x-desktop", undefined],
			["relative.desktop", "Relative", "my-icon", undefined],
			["themed.desktop", "invoice.pdf", "application-pdf", undefined],
			["throws.desktop", undefined, "application-x-desktop", undefined],
		],
	)
})

test("a desktop scan failure carries its context", async () => {
	reset()
	files.delete("/home/test/Desktop")
	assert.deepEqual(error_chain(await load_desktop_files()), [
		"Failed to scan desktop directory",
		"NOT_FOUND",
	])
})

test("launcher files carry every trimmed key in order and a sanitized name", () => {
	reset()
	files.set("/home/test/Desktop/My-App.desktop", "taken")
	assert.deepEqual(
		create_desktop_launcher({
			name: " My App!.desktop ",
			command: " run --now ",
			comment: " says hi ",
			icon: " app-icon ",
			working_directory: " /work ",
			terminal: true,
		}),
		{ ok: true, value: "/home/test/Desktop/My-App (1).desktop" },
	)
	assert.equal(
		files.get("/home/test/Desktop/My-App (1).desktop"),
		[
			"[Desktop Entry]",
			"Type=Application",
			"Name=My App!.desktop",
			"Exec=run --now",
			"Terminal=true",
			"StartupNotify=true",
			"Comment=says hi",
			"Icon=app-icon",
			"Path=/work",
		].join("\n"),
	)
	assert.deepEqual(create_desktop_launcher({ name: "!!!", command: "x" }), {
		ok: true,
		value: "/home/test/Desktop/launcher.desktop",
	})
	assert.equal(
		files.get("/home/test/Desktop/launcher.desktop"),
		[
			"[Desktop Entry]",
			"Type=Application",
			"Name=!!!",
			"Exec=x",
			"Terminal=false",
			"StartupNotify=true",
		].join("\n"),
	)
})

test("text files and folders count up past every taken name", () => {
	reset()
	files.set("/home/test/Desktop/New Text File.txt", "")
	files.set("/home/test/Desktop/New Text File (1).txt", "")
	files.set("/home/test/Desktop/New Folder", "directory")
	files.set("/home/test/Desktop/New Folder 1", "directory")
	assert.deepEqual(create_desktop_text_file(), {
		ok: true,
		value: "/home/test/Desktop/New Text File (2).txt",
	})
	assert.deepEqual(create_desktop_folder(), {
		ok: true,
		value: "/home/test/Desktop/New Folder 2",
	})
})

test("a desktop entry without a launcher opens with the default application", () => {
	reset()
	attributes.set("/home/test/Desktop/app.desktop", {
		"metadata::trusted": "true",
		"access::can-execute": true,
	})
	launchers.set("/home/test/Desktop/app.desktop", null)
	assert.deepEqual(open_path("/home/test/Desktop/app.desktop"), {
		ok: true,
		value: undefined,
	})
	assert.deepEqual(launched, ["file:///home/test/Desktop/app.desktop"])
})

test("file content providers offer the file list, a uri list and the gnome operation", () => {
	assert.deepEqual(
		build_file_content_provider({
			paths: ["/home/test/a", "/home/test/b c"],
			operation: "cut",
		}),
		{
			union: [
				{ value: { files: ["/home/test/a", "/home/test/b c"] } },
				{
					mime: "text/uri-list",
					text: "file:///home/test/a\r\nfile:///home/test/b c\r\n",
				},
				{
					mime: "x-special/gnome-copied-files",
					text: "cut\nfile:///home/test/a\nfile:///home/test/b c",
				},
			],
		},
	)
})

test("clipboard writes and clears report a missing display, throws and refusals", () => {
	reset()
	assert.deepEqual(
		write_clipboard_file_payload({ operation: "copy", paths: [] }),
		{
			ok: true,
			value: undefined,
		},
	)
	assert.deepEqual(clipboard_contents, [])
	assert.deepEqual(
		write_clipboard_file_payload({
			operation: "copy",
			paths: ["/home/test/a"],
		}),
		{
			ok: true,
			value: undefined,
		},
	)
	assert.deepEqual(clear_clipboard_file_payload(), {
		ok: true,
		value: undefined,
	})
	assert.equal(clipboard_contents.length, 2)
	assert.equal(clipboard_contents[1], null)
	assert.deepEqual(
		(clipboard_contents[0] as { union: { text?: string }[] }).union[2].text,
		"copy\nfile:///home/test/a",
	)

	outcomes.set_content = false
	assert.deepEqual(
		error_chain(
			write_clipboard_file_payload({ operation: "cut", paths: ["/a"] }),
		),
		["Failed to write desktop clipboard payload"],
	)
	assert.deepEqual(error_chain(clear_clipboard_file_payload()), [
		"Failed to clear desktop clipboard payload",
	])
	outcomes.set_content = "throw"
	assert.deepEqual(
		error_chain(
			write_clipboard_file_payload({ operation: "cut", paths: ["/a"] }),
		),
		["Failed to write desktop clipboard payload", "FAILED"],
	)
	assert.deepEqual(error_chain(clear_clipboard_file_payload()), [
		"Failed to clear desktop clipboard payload",
		"FAILED",
	])
	outcomes.display = false
	assert.deepEqual(
		error_chain(
			write_clipboard_file_payload({ operation: "cut", paths: ["/a"] }),
		),
		["No display for desktop clipboard"],
	)
	assert.deepEqual(error_chain(clear_clipboard_file_payload()), [
		"No display for desktop clipboard",
	])
})

function text_stream(text: string) {
	let reads = 0
	return {
		read_bytes_async: async () => ({
			get_data: () => (reads++ ? null : new TextEncoder().encode(text)),
		}),
		close_async: async () => true,
	}
}

test("gnome copied files carry the cut operation and empty payloads yield nothing", async (t) => {
	reset()
	const logged = t.mock.method(console, "error", () => {})
	clipboard_mime = "x-special/gnome-copied-files"
	clipboard_stream = text_stream(
		"cut\nfile:///home/test/a\n\nfile:///home/test/b",
	)
	assert.deepEqual(await read_clipboard_file_payload(), {
		operation: "cut",
		paths: ["/home/test/a", "/home/test/b"],
	})
	clipboard_stream = text_stream("other\r\nfile:///home/test/a")
	assert.deepEqual(await read_clipboard_file_payload(), {
		operation: "copy",
		paths: ["/home/test/a"],
	})
	clipboard_stream = text_stream("cut\nhttps://example.org/a")
	assert.equal(await read_clipboard_file_payload(), null)
	clipboard_mime = "text/uri-list"
	clipboard_stream = text_stream("# comment\n")
	assert.equal(await read_clipboard_file_payload(), null)
	assert.deepEqual(
		timeouts.map((entry) => [entry.ms, entry.cancelled]),
		[
			[30_000, true],
			[30_000, true],
			[30_000, true],
			[30_000, true],
		],
	)
	clipboard_mime = "image/png"
	assert.equal(await read_clipboard_file_payload(), null)
	outcomes.display = false
	assert.equal(await read_clipboard_file_payload(), null)
	assert.equal(timeouts.length, 4)
	assert.equal(logged.mock.calls.length, 0)
})

test("a failed clipboard read logs and yields nothing", async (t) => {
	reset()
	const logged = t.mock.method(console, "error", () => {})
	clipboard_stream = null
	assert.equal(await read_clipboard_file_payload(), null)
	assert.deepEqual(
		logged.mock.calls.map((call) => [
			call.arguments[0],
			String(call.arguments[1]),
		]),
		[
			[
				"desktop.clipboard: Failed to read clipboard",
				"Error: Clipboard provided no stream",
			],
		],
	)
})

test("uri lists skip comments and blank lines", () => {
	assert.deepEqual(
		uri_list_paths("# c\r\n file:///home/test/a \r\n\r\nfile:///home/test/b\n"),
		["/home/test/a", "/home/test/b"],
	)
})

test("reading text joins every chunk", async () => {
	const chunks = ["ab", "cd", ""]
	const read = await read_file_text({
		read_bytes_async: async () => ({
			get_data: () => new TextEncoder().encode(chunks.shift()),
		}),
		close_async: async () => true,
	} as unknown as Parameters<typeof read_file_text>[0])
	assert.deepEqual(read, { ok: true, value: "abcd" })
})
