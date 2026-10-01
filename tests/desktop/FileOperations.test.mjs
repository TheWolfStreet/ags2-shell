import assert from "node:assert/strict"
import { readFileSync as read_file_sync } from "node:fs"
import { stripTypeScriptTypes as strip_type_script_types } from "node:module"
import test from "node:test"
import { SourceTextModule as source_text_module, SyntheticModule as synthetic_module } from "node:vm"

const files = new Map()
let before_copy = null
let before_move = null

class io_error extends Error {
	constructor(code) {
		super(code)
		this.code = code
	}
	matches(domain, code) {
		return this.code === code
	}
}

class mock_file {
	constructor(path) {
		this.path = path
	}
	get_path() { return this.path }
	get_basename() { return this.path.split("/").pop() }
	get_parent() { return new mock_file(this.path.slice(0, this.path.lastIndexOf("/"))) }
	get_child(name) { return new mock_file(`${this.path}/${name}`) }
	equal(other) { return this.path === other.path }
	has_prefix(other) { return this.path.startsWith(`${other.path}/`) }
	query_info_async() {
		if (!files.has(this.path)) return Promise.reject(new io_error("NOT_FOUND"))
		return Promise.resolve({ get_file_type: () => files.get(this.path) })
	}
	enumerate_children_async() {
		if (files.get(this.path) !== "directory") return Promise.reject(new io_error("NOT_FOUND"))
		const names = [...files.keys()].filter((path) =>
			path.startsWith(`${this.path}/`) && !path.slice(this.path.length + 1).includes("/"))
		let offset = 0
		return Promise.resolve({
			next_files_async: async (count) => names.slice(offset, offset += count)
				.map((path) => ({ get_name: () => path.split("/").pop() })),
			close_async: async () => true,
		})
	}
	make_directory_async() {
		if (files.has(this.path)) return Promise.reject(new io_error("EXISTS"))
		files.set(this.path, "directory")
		return Promise.resolve(true)
	}
	copy_async(target, flags, priority, cancellable, progress, callback) {
		queueMicrotask(() => {
			before_copy?.(this.path, target.path)
			let error = null
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
	move_async(target, flags, priority, cancellable, progress, callback) {
		queueMicrotask(() => {
			before_move?.(this.path, target.path)
			let error = null
			if (!files.has(this.path)) error = new io_error("NOT_FOUND")
			else if (files.has(target.path)) error = new io_error("EXISTS")
			else if (files.get(this.path) === "directory") error = new io_error("WOULD_RECURSE")
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
		if (files.get(this.path) === "directory" &&
			[...files.keys()].some((path) => path.startsWith(`${this.path}/`)))
			return Promise.reject(new io_error("NOT_EMPTY"))
		files.delete(this.path)
		return Promise.resolve(true)
	}
	query_exists() { return files.has(this.path) }
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
	FileQueryInfoFlags: { NOFOLLOW_SYMLINKS: 1 },
	FileType: { DIRECTORY: "directory" },
	IOErrorEnum: { EXISTS: "EXISTS", WOULD_RECURSE: "WOULD_RECURSE" },
	io_error_quark: () => "gio",
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
	"gi://GioUnix": { default: {} },
	"gi://GLib": { default: glib },
	"ags/gtk4": { Gdk: {} },
	"$lib/time": { timeout: () => ({ cancel: () => {} }) },
	"ags/process": { execAsync: async () => "" },
	"$lib/result": {
		attempt: (fn) => { try { return { ok: true, value: fn() } } catch (err) { return { ok: false, err } } },
		attempt_async: async (fn) => { try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, err } } },
		err: (err) => ({ ok: false, err }),
		log_error: (result) => result.ok,
		ok: (value) => ({ ok: true, value }),
		with_context: (result) => result,
	},
}
const source = read_file_sync(new URL("../../widget/Desktop/FileOperations.ts", import.meta.url), "utf8")
const compiled = strip_type_script_types(source)
const module = new source_text_module(compiled)
await module.link((name) => new synthetic_module(Object.keys(values[name]), function () {
	for (const [key, value] of Object.entries(values[name])) this.setExport(key, value)
}))
await module.evaluate()
const { transfer_desktop_files, rename_file, permanently_delete_files,
	read_file_text, paths_from_uris } = module.namespace

function reset() {
	files.clear()
	files.set("/home/test/Desktop", "directory")
	before_copy = null
	before_move = null
}

test("copy collision retries the actual no-clobber operation", async () => {
	reset()
	files.set("/home/test/Downloads/a.txt", "file")
	before_copy = (source, target) => {
		if (target === "/home/test/Desktop/a.txt") files.set(target, "rival")
	}
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/a.txt"], operation: "copy",
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
		transfer_desktop_files({ paths: ["/home/test/one/same.txt"], operation: "move" }),
		transfer_desktop_files({ paths: ["/home/test/two/same.txt"], operation: "move" }),
	])
	assert.ok(results.every((result) => result.failures.length === 0))
	assert.deepEqual(new Set(results.flatMap((result) => result.createdPaths)), new Set([
		"/home/test/Desktop/same.txt", "/home/test/Desktop/same (1).txt",
	]))
	assert.deepEqual(new Set([
		files.get("/home/test/Desktop/same.txt"),
		files.get("/home/test/Desktop/same (1).txt"),
	]), new Set(["first", "second"]))
})

test("directory move transfers enumerated children then removes the empty source", async () => {
	reset()
	files.set("/home/test/Downloads/folder", "directory")
	files.set("/home/test/Downloads/folder/inside", "file")
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/folder", "/home/test/Downloads/missing"], operation: "move",
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
		paths: ["/home/test/Downloads/folder"], operation: "move",
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
		paths: ["/home/test/Downloads/folder"], operation: "move",
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
		paths: ["/home/test/Downloads/folder"], operation: "move",
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
	before_copy = (source, target) => {
		if (target === "/home/test/Desktop/folder/inside") files.set(target, "rival")
	}
	const result = await transfer_desktop_files({
		paths: ["/home/test/Downloads/folder"], operation: "copy",
	})
	assert.deepEqual(result.createdPaths, [])
	assert.match(String(result.failures[0].error), /Incomplete copy at \/home\/test\/Desktop\/folder/)
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
	const result = await permanently_delete_files(["/home/test/Downloads/item"])
	assert.deepEqual(result.removedPaths, [])
	assert.equal(result.failures.length, 1)
	assert.equal(files.get("/home/test/Downloads/item"), "file")
})

test("file URI parsing rejects nonlocal and non-file URI payloads", () => {
	assert.deepEqual(paths_from_uris([
		"file:///home/test/a%20b", "https://example.org/item", "file://remote/share",
	]), ["/home/test/a b"])
})

test("file URI streams are bounded and closed even on rejection", async () => {
	let closed = false
	let reads = 0
	const stream = {
		read_bytes_async: async () => ({ get_data: () => reads++ ? new Uint8Array(2) : new Uint8Array(1024 * 1024) }),
		close_async: async () => { closed = true; return true },
	}
	await assert.rejects(read_file_text(stream), /exceeds 1 MiB/)
	assert.equal(closed, true)
})
