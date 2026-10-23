import assert from "node:assert/strict"
import { readFileSync as read_file_sync } from "node:fs"
import { stripTypeScriptTypes as strip_type_script_types } from "node:module"
import test from "node:test"
import {
	SourceTextModule as source_text_module,
	SyntheticModule as synthetic_module,
} from "node:vm"

type transfer_hook = (source: string, target: string) => void

const files = new Map<string, string | undefined>()
const attributes = new Map<string, Record<string, string | boolean>>()
let before_copy: transfer_hook | null = null
let before_move: transfer_hook | null = null

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
			next_files_async: async (count) =>
				names.slice(offset, (offset += count)).map((path) => ({
					get_name: () => path.split("/").pop(),
					get_file_type: () => files.get(path),
					get_content_type: () => "application/x-desktop",
					get_modification_date_time: () => null,
					get_icon: () => null,
					get_attribute_string: (name) => attributes.get(path)?.[name] ?? null,
					get_attribute_boolean: (name) =>
						attributes.get(path)?.[name] === true,
				})),
			close_async: async () => true,
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
		return true
	}
	move_async(target, _flags, _priority, _cancellable, _progress, callback) {
		queueMicrotask(() => {
			before_move?.(this.path, target.path)
			let error: io_error | null = null
			if (!files.has(this.path)) error = new io_error("NOT_FOUND")
			else if (files.has(target.path)) error = new io_error("EXISTS")
			else if (files.get(this.path) === "directory")
				error = new io_error("WOULD_RECURSE")
			else {
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
	query_exists() {
		return files.has(this.path)
	}
	move(target) {
		if (files.has(target.path)) throw new io_error("EXISTS")
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
	FileQueryInfoFlags: { NONE: 0, NOFOLLOW_SYMLINKS: 1 },
	FileType: { DIRECTORY: "directory" },
	IOErrorEnum: { EXISTS: "EXISTS", WOULD_RECURSE: "WOULD_RECURSE" },
	io_error_quark: () => "gio",
	content_type_get_icon: () => ({ get_names: () => ["application-x-desktop"] }),
}
const glib = {
	Error: io_error,
	PRIORITY_DEFAULT: 0,
	UserDirectory: { DIRECTORY_DESKTOP: 0 },
	get_user_special_dir: () => "/home/test/Desktop",
	get_home_dir: () => "/home/test",
	path_is_absolute: (path) => path.startsWith("/"),
}

const values = {
	"gi://Gio": { default: gio },
	"gi://GioUnix": {
		default: {
			DesktopAppInfo: {
				new_from_filename: () => ({
					get_icon: () => ({ get_names: () => ["application-pdf"] }),
					get_string: () => null,
					get_display_name: () => "invoice.pdf",
					get_name: () => "invoice.pdf",
				}),
			},
		},
	},
	"gi://GLib": { default: glib },
	"ags/gtk4": { Gdk: {} },
	"$lib/time": { timeout: () => ({ cancel: () => {} }) },
	"ags/process": { execAsync: async () => "" },
	"$lib/result": {
		attempt: (fn) => {
			try {
				return { ok: true, value: fn() }
			} catch (err) {
				return { ok: false, err }
			}
		},
		attempt_async: async (fn) => {
			try {
				return { ok: true, value: await fn() }
			} catch (err) {
				return { ok: false, err }
			}
		},
		err: (err) => ({ ok: false, err }),
		log_error: (result) => result.ok,
		ok: (value) => ({ ok: true, value }),
		with_context: (result) => result,
	},
}
async function load_values_module(path: string) {
	const source = read_file_sync(new URL(path, import.meta.url), "utf8")
	const loaded = new source_text_module(strip_type_script_types(source))
	await loaded.link(
		(name) =>
			new synthetic_module(Object.keys(values[name]), function () {
				for (const [key, value] of Object.entries(values[name]))
					this.setExport(key, value)
			}),
	)
	await loaded.evaluate()
	return loaded
}
values["$lib/files"] = (await load_values_module("../../lib/files.ts"))
	.namespace as Record<string, unknown>
const module = await load_values_module(
	"../../widget/Desktop/FileOperations.ts",
)
const {
	transfer_desktop_files,
	rename_file,
	delete_desktop_files,
	load_desktop_files,
	read_file_text,
	paths_from_uris,
} = module.namespace as typeof import("../../widget/Desktop/FileOperations.ts")

function reset() {
	files.clear()
	attributes.clear()
	files.set("/home/test/Desktop", "directory")
	before_copy = null
	before_move = null
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
	assert.deepEqual(result.createdPaths, ["/home/test/Desktop/a (1).txt"])
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
		new Set(results.flatMap((result) => result.createdPaths)),
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
	assert.deepEqual(result.createdPaths, ["/home/test/Desktop/folder"])
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
	assert.deepEqual(result.createdPaths, [])
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
	assert.deepEqual(result.createdPaths, [])
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
	assert.deepEqual(result.createdPaths, [])
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
	assert.deepEqual(result.createdPaths, [])
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
	for (const name of ["../outside", "/tmp/outside", ".", "..", "a\0b"]) {
		assert.equal(rename_file("/home/test/Desktop/item", name).ok, false)
	}
	assert.equal(files.get("/home/test/Desktop/item"), "file")
})

test("permanent removal refuses files outside the Desktop", async () => {
	reset()
	files.set("/home/test/Downloads/item", "file")
	const result = await delete_desktop_files(
		["/home/test/Downloads/item"],
		"delete",
	)
	assert.deepEqual(result.removedPaths, [])
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
		assert.equal(by_name.get(name)?.displayName, undefined)
		assert.equal(by_name.get(name)?.icon, "application-x-desktop")
	}
	assert.equal(by_name.get("trusted.desktop")?.displayName, "invoice.pdf")
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
	await assert.rejects(
		read_file_text(stream as unknown as Parameters<typeof read_file_text>[0]),
		/exceeds 1 MiB/,
	)
	assert.equal(closed, true)
})
