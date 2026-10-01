import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { registerHooks, stripTypeScriptTypes } from "node:module"
import { SourceTextModule, SyntheticModule } from "node:vm"

const gnim_source = stripTypeScriptTypes(readFileSync(
	new URL("../../node_modules/gnim/dist/jsx/state.ts", import.meta.url), "utf8",
))
const gnim = new SourceTextModule(gnim_source)
await gnim.link(name => {
	const exports = name === "gi://GObject"
		? { default: { Object: class { connect() {} disconnect() {} }, TYPE_JSOBJECT: 1 } }
		: name === "gi://Gio" || name === "gi://GLib"
			? { default: {} }
			: name === "../util.js"
				? { camelify: value => value, kebabify: value => value }
				: name === "./scope.js"
					? { Scope: class {} }
					: null
	assert.ok(exports, name)
	return new SyntheticModule(Object.keys(exports), function () {
		for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
	})
})
await gnim.evaluate()
const { createState, createComputed } = gnim.namespace

const files = new Map()
const reads = []
const decodes = []
const downloads = []
const cache = new Map()
let closed = 0
let dimensions = [8, 8]

const pixbuf = {
	get_width: () => 8,
	get_height: () => 8,
	scale_simple: () => ({ copy_area() {} }),
}
const mocks = {
	ags: { createState },
	gdk: { Gdk: { Texture: { new_for_pixbuf: () => ({ image: true }) },
		MemoryTexture: { new: () => ({}) }, MemoryFormat: { R8G8B8A8: 0 } } },
	glib: {
		Error: class extends Error {}, get_monotonic_time: () => 0,
		path_is_absolute: path => path.startsWith("/"),
		get_user_cache_dir: () => "/mock-cache", uuid_string_random: () => "temporary",
		compute_checksum_for_string: (_type, uri) => uri.replace(/\W/g, "a").slice(0, 40).padEnd(40, "b"),
		ChecksumType: { SHA1: 1 }, PRIORITY_DEFAULT: 0, mkdir_with_parents: () => 0,
	},
	gio: {
		FileQueryInfoFlags: { NONE: 0, NOFOLLOW_SYMLINKS: 1 },
		FileCopyFlags: { OVERWRITE: 1 }, SubprocessFlags: { STDOUT_SILENCE: 1, STDERR_SILENCE: 2 },
		io_error_quark: () => 0, IOErrorEnum: { NOT_FOUND: 1 },
		File: {
			new_for_uri: uri => ({ get_path: () => {
				const url = new URL(uri)
				return url.protocol === "file:" && (!url.hostname || url.hostname === "localhost")
					? decodeURIComponent(url.pathname) : null
			} }),
			new_for_path: path => ({
				enumerate_children: () => ({ next_file: () => null, close() {} }),
				query_info: () => {
					const data = files.get(path) ?? cache.get(path)
					if (!data) throw new Error("missing")
					return { get_size: () => data.size ?? 100,
						get_attribute_uint64: () => data.modified ?? 1,
						get_attribute_uint32: () => data.usec ?? 0,
						get_attribute_string: () => data.etag ?? "" }
				},
				read_async: (_priority, _cancel, callback) => { reads.push({ path, callback }) },
				read_finish: () => ({ close: () => { closed++ } }),
				move: target => { cache.set(target.path, { size: 100, modified: Date.now() / 1000 }); return true },
				delete: () => { cache.delete(path); return true },
				path,
			}),
		},
		Subprocess: { new: () => ({ wait_async: (_cancel, callback) => downloads.push(callback),
			wait_finish: () => true, get_successful: () => true }) },
	},
	pixbuf: {
		InterpType: { BILINEAR: 0 }, Colorspace: { RGB: 0 },
		Pixbuf: {
			get_file_info: () => [{}, ...dimensions],
			new_from_file_at_scale: () => pixbuf,
			new_from_stream_at_scale_async: (_stream, _width, _height, _aspect, _cancel, callback) => decodes.push(callback),
			new_from_stream_finish: () => pixbuf,
			new: () => ({ fill() {}, get_width: () => 8, get_height: () => 8 }),
		},
	},
	env: { paths: { cache: { base: "/mock-cache" } } },
	result: { attempt: fn => { try { return { ok: true, value: fn() } } catch (err) { return { ok: false, err } } } },
}
globalThis.__texture_mocks = mocks

const names = new Map([
	["ags", "ags"], ["ags/gtk4", "gdk"], ["gi://GLib", "glib"],
	["gi://Gio", "gio"], ["gi://GdkPixbuf", "pixbuf"],
	["$lib/env", "env"], ["$lib/result", "result"],
])
registerHooks({
	resolve(specifier, context, next) {
		const name = names.get(specifier)
		return name ? { url: `texture-mock:${name}`, shortCircuit: true } : next(specifier, context)
	},
	load(url, context, next) {
		return url.startsWith("texture-mock:")
			? { format: "module", source: `export default globalThis.__texture_mocks.${url.slice(13)};
				export const createState = globalThis.__texture_mocks.ags.createState;
				export const Gdk = globalThis.__texture_mocks.gdk.Gdk;
				export const attempt = globalThis.__texture_mocks.result.attempt;`, shortCircuit: true }
			: next(url, context)
	},
})

const { create_square_texture_accessor } = await import("../../lib/textures.ts")

test("file URI decoding and revision keys prevent stale async delivery", () => {
	files.set("/mock/a b.png", { size: 100, usec: 1 })
	const old = create_square_texture_accessor("file:///mock/a%20b.png", 32)
	assert.equal(reads.at(-1).path, "/mock/a b.png")
	files.set("/mock/a b.png", { size: 100, usec: 2 })
	const fresh = create_square_texture_accessor("file:///mock/a%20b.png", 32)
	assert.notEqual(fresh, old)
	reads.shift().callback(null, {})
	decodes.shift()(null, {})
	assert.equal(old(), null)
	assert.equal(closed, 1)
	reads.shift().callback(null, {})
	decodes.shift()(null, {})
	assert.deepEqual(fresh(), { image: true })
	assert.equal(closed, 2)
})

test("HTTP requests for different sizes share one download", () => {
	const uri = "https://example.invalid/cover.png"
	const first = create_square_texture_accessor(uri, 40)
	const second = create_square_texture_accessor(uri, 80)
	assert.equal(downloads.length, 1)
	cache.set("/mock-cache/artwork/.temporary", { size: 100 })
	downloads.shift()(null, {})
	assert.deepEqual(first(), { image: true })
	assert.deepEqual(second(), { image: true })
})

test("HTTP oversized response is discarded without publishing a texture", () => {
	const previous = console.error
	const errors = []
	console.error = (...args) => errors.push(args)
	try {
		const texture = create_square_texture_accessor("https://example.invalid/too-large", 40)
		cache.set("/mock-cache/artwork/.temporary", { size: 8 * 1024 * 1024 + 1 })
		downloads.shift()(null, {})
		assert.equal(texture(), null)
		assert.equal(cache.has("/mock-cache/artwork/.temporary"), false)
		assert.equal(errors.length, 1)
	} finally {
		console.error = previous
	}
})

test("oversized decoded dimensions are rejected before opening a local stream", () => {
	files.set("/mock/giant.png", { size: 100 })
	const before = reads.length
	const previous = console.error
	console.error = () => {}
	try {
		dimensions = [9000, 8]
		assert.equal(create_square_texture_accessor("/mock/giant.png", 32)(), null)
		assert.equal(reads.length, before)
	} finally {
		dimensions = [8, 8]
		console.error = previous
	}
})

test("oversized local files are rejected before any stream is opened", () => {
	files.set("/mock/oversized-file.png", { size: 64 * 1024 * 1024 + 1 })
	const before = reads.length
	const errors = []
	const previous = console.error
	console.error = (...args) => errors.push(args)
	try {
		assert.equal(create_square_texture_accessor("/mock/oversized-file.png", 32)(), null)
		assert.equal(reads.length, before)
		assert.equal(errors.length, 1)
	} finally {
		console.error = previous
	}
})

test("only four local decodes run and the pending queue is bounded", () => {
	const initial = reads.length
	const textures = []
	const errors = []
	const previous = console.error
	console.error = (...args) => errors.push(args)
	try {
		for (let index = 0; index < 69; index++) {
			const path = `/mock/${index}.png`
			files.set(path, { size: 100 })
			textures.push(create_square_texture_accessor(path, 32))
		}
	} finally {
		console.error = previous
	}
	assert.equal(reads.length - initial, 4)
	assert.equal(errors.filter(([, cause]) => cause?.message === "Artwork queue full").length, 1)
	while (reads.length) {
		reads.shift().callback(null, {})
		decodes.shift()(null, {})
	}
	for (const texture of textures.slice(0, 68)) assert.deepEqual(texture(), { image: true })
	assert.equal(textures[68](), null)
})

test("68 rendered Gnim consumers drain once even after texture cache eviction", () => {
	const views = []
	const dispose = []
	let lookups = 0
	for (let index = 0; index < 68; index++) {
		const path = `/render/${index}.png`
		files.set(path, { size: 100 })
		const selected = createComputed(() => {
			lookups++
			return create_square_texture_accessor(path, 32)
		})
		const rendered = createComputed(() => selected()())
		dispose.push(rendered.subscribe(() => rendered.peek()))
		views.push(rendered)
	}
	assert.equal(reads.length, 4)
	const initial_lookups = lookups
	assert.equal(initial_lookups, 136)
	while (reads.length) {
		reads.shift().callback(null, {})
		decodes.shift()(null, {})
	}
	assert.equal(lookups, initial_lookups)
	for (const view of views) assert.deepEqual(view.peek(), { image: true })
	assert.equal(reads.length, 0)
	for (const unsubscribe of dispose) unsubscribe()
})

test("Gnim selection switches on URI, size, and explicit revision", () => {
	files.set("/selection/one.png", { size: 100, usec: 1 })
	files.set("/selection/two.png", { size: 100, usec: 1 })
	const [uri, set_uri] = createState("/selection/one.png")
	const [size, set_size] = createState(32)
	const [revision, set_revision] = createState(0)
	let lookups = 0
	const selected = createComputed(() => {
		revision()
		lookups++
		return create_square_texture_accessor(uri(), size())
	})
	const rendered = createComputed(() => selected()())
	const unsubscribe = rendered.subscribe(() => rendered.peek())
	const complete = () => {
		reads.shift().callback(null, {})
		decodes.shift()(null, {})
		assert.deepEqual(rendered.peek(), { image: true })
	}
	try {
		complete()
		set_size(48)
		assert.equal(rendered.peek(), null)
		complete()
		set_uri("/selection/two.png")
		assert.equal(rendered.peek(), null)
		complete()
		files.set("/selection/two.png", { size: 100, usec: 2 })
		set_revision(1)
		assert.equal(rendered.peek(), null)
		complete()
		assert.equal(lookups, 5)
		assert.equal(reads.length, 0)
	} finally {
		unsubscribe()
	}
})
