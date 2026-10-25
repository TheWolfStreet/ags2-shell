import { test } from "node:test"
import assert from "node:assert/strict"
import type {
	Accessor,
	createComputed as Computed,
	createState as State,
} from "gnim"
import { load_module } from "../load_module.ts"

const gnim = await load_module("node_modules/gnim/dist/jsx/state.ts", {
	"gi://GObject": {
		default: {
			Object: class {
				connect() {}
				disconnect() {}
			},
			TYPE_JSOBJECT: 1,
		},
	},
	"gi://Gio": { default: {} },
	"gi://GLib": { default: {} },
	"../util.js": { camelify: (value) => value, kebabify: (value) => value },
	"./scope.js": { Scope: class {} },
})
const { createState, createComputed } = gnim as {
	createState: typeof State
	createComputed: typeof Computed
}

type read_request = {
	path: string
	callback: (source: unknown, result: unknown) => void
}
type async_callback = (source: unknown, result: unknown) => void
type dimensions = { get_width(): number; get_height(): number }
type file_data = {
	size?: number
	modified?: number
	usec?: number
	etag?: string
}

const files = new Map<string, file_data>()
const reads: read_request[] = []
const decodes: async_callback[] = []
const decode_bounds: number[][] = []
const file_decode_bounds: number[][] = []
const downloads: async_callback[] = []
const created: dimensions[] = []
const cache = new Map<string, file_data>()
const faults = new Set<string>()
const listing: { name: string; size: number; modified: number }[] = []
const deleted: string[] = []
let closed = 0
let enumerators_closed = 0
let loader_closed = 0
let dimensions = [8, 8]
let image_dimensions = [8, 8]

const pixbuf = {
	get_width: () => image_dimensions[0],
	get_height: () => image_dimensions[1],
	scale_simple: () => (faults.has("scale") ? null : { copy_area() {} }),
}
const mocks = {
	ags: { createState },
	gdk: {
		Gdk: {
			Texture: {
				new_for_pixbuf: (value) => {
					created.push(value)
					return { image: true }
				},
			},
			MemoryTexture: { new: () => ({}) },
			MemoryFormat: { R8G8B8A8: 0 },
		},
	},
	glib: {
		Error: class extends Error {
			code: number
			constructor(code: number) {
				super(`io error ${code}`)
				this.code = code
			}
			matches(_domain, code) {
				return code === this.code
			}
		},
		get_monotonic_time: () => 0,
		path_is_absolute: (path) => path.startsWith("/"),
		get_user_cache_dir: () => "/mock-cache",
		uuid_string_random: () => "temporary",
		compute_checksum_for_string: (_type, uri) =>
			uri.replace(/\W/g, "a").slice(0, 40).padEnd(40, "b"),
		ChecksumType: { SHA1: 1 },
		PRIORITY_DEFAULT: 0,
		mkdir_with_parents: () => (faults.has("mkdir") ? -1 : 0),
		base64_decode: (encoded) =>
			faults.has("huge-decode")
				? { length: 8 * 1024 * 1024 + 1 }
				: Buffer.from(encoded, "base64"),
		Bytes: class {},
	},
	gio: {
		FileQueryInfoFlags: { NONE: 0, NOFOLLOW_SYMLINKS: 1 },
		FileCopyFlags: { OVERWRITE: 1 },
		SubprocessFlags: { STDOUT_SILENCE: 1, STDERR_SILENCE: 2 },
		io_error_quark: () => 0,
		IOErrorEnum: { NOT_FOUND: 1 },
		File: {
			new_for_uri: (uri) => ({
				get_path: () => {
					const url = new URL(uri)
					return url.protocol === "file:" &&
						(!url.hostname || url.hostname === "localhost")
						? decodeURIComponent(url.pathname)
						: null
				},
			}),
			new_for_path: (path) => ({
				enumerate_children: () => {
					if (faults.has("enumerate")) throw new Error("enumerate failed")
					const pending = listing.map((entry) => ({
						get_name: () => entry.name,
						get_size: () => entry.size,
						get_attribute_uint64: () => entry.modified,
					}))
					return {
						next_file: () => {
							if (faults.has("next-file")) throw new Error("next failed")
							return pending.shift() ?? null
						},
						close() {
							enumerators_closed++
						},
					}
				},
				query_info: () => {
					const data = files.get(path) ?? cache.get(path)
					if (!data) throw new Error("missing")
					return {
						get_size: () => data.size ?? 100,
						get_attribute_uint64: () => data.modified ?? 1,
						get_attribute_uint32: () => data.usec ?? 0,
						get_attribute_string: () => data.etag ?? "",
					}
				},
				read_async: (_priority, _cancel, callback) => {
					if (faults.has("read-start")) throw new Error("read start failed")
					reads.push({ path, callback })
				},
				read_finish: () => {
					if (faults.has("read-finish")) throw new Error("read failed")
					return {
						close: () => {
							closed++
							if (faults.has("stream-close"))
								throw new Error("stream close failed")
						},
					}
				},
				move: (target) => {
					if (faults.has("move-throws")) throw new Error("move failed")
					if (faults.has("move")) return false
					cache.delete(path)
					cache.set(target.path, { size: 100, modified: Date.now() / 1000 })
					return true
				},
				delete: () => {
					deleted.push(path)
					if (faults.has("delete-missing"))
						throw new mocks.glib.Error(mocks.gio.IOErrorEnum.NOT_FOUND)
					if (faults.has("delete-throws")) throw new Error("delete failed")
					if (faults.has("delete-false")) return false
					cache.delete(path)
					return true
				},
				path,
			}),
		},
		Subprocess: {
			new: () => {
				if (faults.has("spawn")) throw new Error("spawn failed")
				return {
					wait_async: (_cancel, callback) => downloads.push(callback),
					wait_finish: () => {
						if (faults.has("wait")) throw new Error("wait failed")
						return true
					},
					get_successful: () => !faults.has("curl"),
				}
			},
		},
	},
	pixbuf: {
		InterpType: { BILINEAR: 0 },
		Colorspace: { RGB: 0 },
		Pixbuf: {
			get_file_info: () => {
				if (faults.has("file-info")) throw new Error("file info failed")
				return [{}, ...dimensions]
			},
			new_from_file_at_scale: (_path, width, height) => {
				if (faults.has("file-decode")) throw new Error("decode failed")
				file_decode_bounds.push([width, height])
				return pixbuf
			},
			new_from_stream_at_scale_async: (
				_stream,
				width,
				height,
				_aspect,
				_cancel,
				callback,
			) => {
				if (faults.has("decode-start")) throw new Error("decode start failed")
				decode_bounds.push([width, height])
				decodes.push(callback)
			},
			new_from_stream_finish: () => pixbuf,
			new: (_space, _alpha, _bits, width, height) =>
				faults.has("allocate")
					? null
					: {
							fill() {},
							get_width: () => width,
							get_height: () => height,
						},
		},
		PixbufLoader: {
			new: () => {
				let prepared: (
					loader: unknown,
					width: number,
					height: number,
				) => void = () => {}
				return {
					connect: (_signal, callback) => {
						prepared = callback
					},
					set_size() {},
					write_bytes() {
						if (faults.has("write")) throw new Error("write failed")
						prepared(null, image_dimensions[0], image_dimensions[1])
					},
					close() {
						loader_closed++
						if (faults.has("close")) throw new Error("close failed")
						return true
					},
					get_pixbuf: () => (faults.has("no-pixbuf") ? null : pixbuf),
				}
			},
		},
	},
	env: { paths: { cache: { base: "/mock-cache" } } },
}

const files_module = await load_module("lib/files.ts", {
	"gi://Gio": { default: mocks.gio },
	"gi://GLib": { default: mocks.glib },
})
const {
	create_display_texture,
	create_texture_accessor,
	texture_from_file_square_contain,
} = await load_module("lib/textures.ts", {
	ags: { createState },
	"ags/gtk4": { Gdk: mocks.gdk.Gdk },
	"gi://GLib": { default: mocks.glib },
	"gi://Gio": { default: mocks.gio },
	"gi://GdkPixbuf": { default: mocks.pixbuf },
	"$lib/env": { default: mocks.env },
	"$lib/files": files_module,
})

test("direct square textures also clamp before decoding and caching", () => {
	files.set("/mock/direct.png", { size: 100 })
	const oversized = texture_from_file_square_contain("/mock/direct.png", 520)
	assert.deepEqual(file_decode_bounds.at(-1), [512, 512])
	assert.equal(
		texture_from_file_square_contain("/mock/direct.png", 512),
		oversized,
	)
	assert.equal(texture_from_file_square_contain("/mock/direct.png", 0), null)
})

test("overscale requests share the bounded decode and cache entry", () => {
	files.set("/mock/zoom.png", { size: 100 })
	const initial = reads.length
	const zoomed = create_texture_accessor("/mock/zoom.png", 520, "contain")
	const maximum = create_texture_accessor("/mock/zoom.png", 512, "contain")
	assert.equal(zoomed, maximum)
	assert.equal(reads.length, initial + 1)
	reads.shift()!.callback(null, {})
	assert.deepEqual(decode_bounds.at(-1), [512, 512])
	decodes.shift()!(null, {})
	assert.deepEqual(zoomed(), { image: true })
	assert.deepEqual(
		create_texture_accessor("/mock/zoom.png", 520, "contain")(),
		{ image: true },
	)
	assert.equal(reads.length, initial)
	assert.equal(create_texture_accessor("/mock/zoom.png", 0, "contain")(), null)
})

test("an accepted 6000x6000 wallpaper decodes as a thumbnail but 6400x6400 is rejected", () => {
	files.set("/mock/wallpaper.png", { size: 64 * 1024 * 1024 })
	const initial = reads.length
	const previous = console.error
	console.error = () => {}
	try {
		dimensions = [6000, 6000]
		const preview = create_texture_accessor("/mock/wallpaper.png", 520)
		assert.equal(reads.length, initial + 1)
		reads.shift()!.callback(null, {})
		assert.deepEqual(decode_bounds.at(-1), [512, 512])
		decodes.shift()!(null, {})
		assert.deepEqual(preview(), { image: true })
		dimensions = [6400, 6400]
		files.set("/mock/too-many-pixels.png", { size: 100 })
		assert.equal(
			create_texture_accessor("/mock/too-many-pixels.png", 32)(),
			null,
		)
		assert.equal(reads.length, initial)
	} finally {
		dimensions = [8, 8]
		console.error = previous
	}
})

test("HTTP requests above 512 share the same bounded subscriber", () => {
	const uri = "https://example.invalid/overscale.png"
	const zoomed = create_texture_accessor(uri, 520, "contain")
	const maximum = create_texture_accessor(uri, 512, "contain")
	assert.equal(zoomed, maximum)
	assert.equal(downloads.length, 1)
	cache.set("/mock-cache/artwork/.temporary", { size: 100 })
	downloads.shift()!(null, {})
	assert.deepEqual(zoomed(), { image: true })
})

test("display textures decode at the requested size without the thumbnail cap or cache", () => {
	files.set("/mock/display.png", { size: 100 })
	image_dimensions = [2560, 1600]
	try {
		const initial = reads.length
		const preview = create_display_texture("/mock/display.png", 1850)
		const again = create_display_texture("/mock/display.png", 1850)
		assert.notEqual(preview, again)
		assert.equal(reads.length, initial + 2)
		reads.shift()!.callback(null, {})
		assert.deepEqual(decode_bounds.at(-1), [1850, 1850])
		decodes.shift()!(null, {})
		assert.equal(created.at(-1), pixbuf)
		assert.deepEqual(preview(), { image: true })
		reads.shift()!.callback(null, {})
		decodes.shift()!(null, {})
		create_display_texture("/mock/display.png", 20000)
		reads.shift()!.callback(null, {})
		assert.deepEqual(decode_bounds.at(-1), [8192, 8192])
		decodes.shift()!(null, {})
		assert.equal(create_display_texture("/mock/display.png", 0)(), null)
		assert.equal(create_display_texture("", 1850)(), null)
		create_texture_accessor("/mock/display.png", 1850, "contain")
		reads.shift()!.callback(null, {})
		assert.deepEqual(decode_bounds.at(-1), [512, 512])
		decodes.shift()!(null, {})
		assert.equal(reads.length, initial)
	} finally {
		image_dimensions = [8, 8]
	}
})

test("notification-style preview keeps landscape dimensions without square padding", () => {
	files.set("/mock/landscape.png", { size: 100 })
	image_dimensions = [80, 45]
	try {
		const preview = create_texture_accessor(
			"/mock/landscape.png",
			80,
			"contain",
		)
		const square = create_texture_accessor("/mock/landscape.png", 80)
		assert.notEqual(preview, square)
		assert.equal(decodes.length, 0)
		reads.shift()!.callback(null, {})
		decodes.shift()!(null, {})
		assert.equal(created.at(-1), pixbuf)
		assert.deepEqual(
			[created.at(-1)!.get_width(), created.at(-1)!.get_height()],
			[80, 45],
		)
		assert.deepEqual(preview(), { image: true })
		reads.shift()!.callback(null, {})
		decodes.shift()!(null, {})
		assert.deepEqual(
			[created.at(-1)!.get_width(), created.at(-1)!.get_height()],
			[80, 80],
		)
	} finally {
		image_dimensions = [8, 8]
	}
})

test("portrait preview keeps its aspect and HTTP fit variants share the download", () => {
	const uri = "https://example.invalid/portrait.png"
	image_dimensions = [130, 260]
	try {
		const preview = create_texture_accessor(uri, 260, "contain")
		const square = create_texture_accessor(uri, 260)
		assert.equal(downloads.length, 1)
		cache.set("/mock-cache/artwork/.temporary", { size: 100 })
		downloads.shift()!(null, {})
		assert.deepEqual(preview(), { image: true })
		assert.deepEqual(square(), { image: true })
		assert.deepEqual(
			created.slice(-2).map((value) => [value.get_width(), value.get_height()]),
			[
				[130, 260],
				[260, 260],
			],
		)
	} finally {
		image_dimensions = [8, 8]
	}
})

test("file URI decoding and revision keys prevent stale async delivery", () => {
	const initial_closed = closed
	files.set("/mock/a b.png", { size: 100, usec: 1 })
	const old = create_texture_accessor("file:///mock/a%20b.png", 32)
	assert.equal(reads.at(-1)!.path, "/mock/a b.png")
	files.set("/mock/a b.png", { size: 100, usec: 2 })
	const fresh = create_texture_accessor("file:///mock/a%20b.png", 32)
	assert.notEqual(fresh, old)
	reads.shift()!.callback(null, {})
	decodes.shift()!(null, {})
	assert.equal(old(), null)
	assert.equal(closed, initial_closed + 1)
	reads.shift()!.callback(null, {})
	decodes.shift()!(null, {})
	assert.deepEqual(fresh(), { image: true })
	assert.equal(closed, initial_closed + 2)
})

test("HTTP requests for different sizes share one download", () => {
	const uri = "https://example.invalid/cover.png"
	const first = create_texture_accessor(uri, 40)
	const second = create_texture_accessor(uri, 80)
	assert.equal(downloads.length, 1)
	cache.set("/mock-cache/artwork/.temporary", { size: 100 })
	downloads.shift()!(null, {})
	assert.deepEqual(first(), { image: true })
	assert.deepEqual(second(), { image: true })
})

test("HTTP oversized response is discarded without publishing a texture", () => {
	const previous = console.error
	const errors: unknown[][] = []
	console.error = (...args) => errors.push(args)
	try {
		const texture = create_texture_accessor(
			"https://example.invalid/too-large",
			40,
		)
		cache.set("/mock-cache/artwork/.temporary", { size: 8 * 1024 * 1024 + 1 })
		downloads.shift()!(null, {})
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
		assert.equal(create_texture_accessor("/mock/giant.png", 32)(), null)
		assert.equal(reads.length, before)
	} finally {
		dimensions = [8, 8]
		console.error = previous
	}
})

test("oversized local files are rejected before any stream is opened", () => {
	files.set("/mock/oversized-file.png", { size: 64 * 1024 * 1024 + 1 })
	const before = reads.length
	const errors: unknown[][] = []
	const previous = console.error
	console.error = (...args) => errors.push(args)
	try {
		assert.equal(
			create_texture_accessor("/mock/oversized-file.png", 32)(),
			null,
		)
		assert.equal(reads.length, before)
		assert.equal(errors.length, 1)
	} finally {
		console.error = previous
	}
})

test("only four local decodes run and the pending queue is bounded", () => {
	const initial = reads.length
	const textures: Accessor<unknown>[] = []
	const errors: unknown[][] = []
	const previous = console.error
	console.error = (...args) => errors.push(args)
	try {
		for (let index = 0; index < 69; index++) {
			const path = `/mock/${index}.png`
			files.set(path, { size: 100 })
			textures.push(create_texture_accessor(path, 32))
		}
	} finally {
		console.error = previous
	}
	assert.equal(reads.length - initial, 4)
	assert.equal(
		errors.filter(
			([, cause]) =>
				(cause as Error | undefined)?.message === "Artwork queue full",
		).length,
		1,
	)
	while (reads.length) {
		reads.shift()!.callback(null, {})
		decodes.shift()!(null, {})
	}
	for (const texture of textures.slice(0, 68))
		assert.deepEqual(texture(), { image: true })
	assert.equal(textures[68](), null)
})

test("68 rendered Gnim consumers drain once even after texture cache eviction", () => {
	const views: Accessor<unknown>[] = []
	const dispose: (() => void)[] = []
	let lookups = 0
	for (let index = 0; index < 68; index++) {
		const path = `/render/${index}.png`
		files.set(path, { size: 100 })
		const selected = createComputed(() => {
			lookups++
			return create_texture_accessor(path, 32)
		})
		const rendered = createComputed(() => selected()())
		dispose.push(rendered.subscribe(() => rendered.peek()))
		views.push(rendered)
	}
	assert.equal(reads.length, 4)
	const initial_lookups = lookups
	assert.equal(initial_lookups, 136)
	while (reads.length) {
		reads.shift()!.callback(null, {})
		decodes.shift()!(null, {})
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
		return create_texture_accessor(uri(), size())
	})
	const rendered = createComputed(() => selected()())
	const unsubscribe = rendered.subscribe(() => rendered.peek())
	const complete = () => {
		reads.shift()!.callback(null, {})
		decodes.shift()!(null, {})
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

function failures(active: string[], run: () => void): string[] {
	const errors: unknown[][] = []
	const previous = console.error
	console.error = (...args) => errors.push(args)
	for (const fault of active) faults.add(fault)
	try {
		run()
	} finally {
		faults.clear()
		console.error = previous
	}
	return errors.map(([, error]) => (error as Error).message)
}

function inline_failure(
	active: string[],
	size: number,
	uri = "data:image/png;base64,iVBORw0KGgo=",
) {
	let texture: Accessor<unknown> | null = null
	const messages = failures(active, () => {
		texture = create_texture_accessor(uri, size)
	})
	assert.equal(texture!(), null)
	return messages
}

test("inline artwork decodes through the loader", () => {
	const texture = create_texture_accessor(
		"data:image/png;base64,iVBORw0KGgo=",
		101,
	)
	assert.deepEqual(texture(), { image: true })
})

test("inline artwork failures carry their reason", () => {
	assert.deepEqual(inline_failure([], 102, "data:image/png,iVBORw0KGgo="), [
		"Unsupported inline image encoding",
	])
	assert.deepEqual(
		inline_failure([], 103, `data:image/png;base64,${"A".repeat(11_184_820)}`),
		["Inline artwork exceeds 8 MiB"],
	)
	assert.deepEqual(
		inline_failure(
			[],
			110,
			`data:image/png;base64,iVBORw0KGgo=${" ".repeat(11_184_818)}`,
		),
		["Inline artwork exceeds 8 MiB"],
	)
	assert.deepEqual(
		logged([], () =>
			assert.equal(
				create_texture_accessor(`iVBORw0KGgo${"A".repeat(11_184_930)}`, 111)(),
				null,
			),
		),
		[["textures: Image URI exceeds length limit", undefined]],
	)
	assert.deepEqual(inline_failure(["huge-decode"], 104), [
		"Inline artwork exceeds 8 MiB",
	])
	assert.deepEqual(inline_failure(["no-pixbuf"], 105), [
		"Failed to decode inline image",
	])
	image_dimensions = [9000, 8]
	try {
		assert.deepEqual(inline_failure([], 106), [
			"Invalid or oversized inline image dimensions",
		])
	} finally {
		image_dimensions = [8, 8]
	}
})

test("inline loader is closed after a failed write and its close error wins", () => {
	const before = loader_closed
	assert.deepEqual(inline_failure(["write"], 107), ["write failed"])
	assert.equal(loader_closed, before + 1)
	assert.deepEqual(inline_failure(["close"], 108), ["close failed"])
	assert.deepEqual(inline_failure(["write", "close"], 109), ["close failed"])
	assert.equal(loader_closed, before + 3)
})

test("direct square textures report scale, allocation, and dimension failures", () => {
	files.set("/mock/direct-fail.png", { size: 100 })
	assert.deepEqual(
		failures(["scale"], () =>
			assert.equal(
				texture_from_file_square_contain("/mock/direct-fail.png", 60),
				null,
			),
		),
		["Failed to scale image"],
	)
	assert.deepEqual(
		failures(["allocate"], () =>
			assert.equal(
				texture_from_file_square_contain("/mock/direct-fail.png", 61),
				null,
			),
		),
		["Failed to allocate square image"],
	)
	assert.deepEqual(
		failures(["file-info"], () =>
			assert.equal(
				texture_from_file_square_contain("/mock/direct-fail.png", 63),
				null,
			),
		),
		["file info failed"],
	)
	dimensions = [9000, 8]
	try {
		assert.deepEqual(
			failures([], () =>
				assert.equal(
					texture_from_file_square_contain("/mock/direct-fail.png", 62),
					null,
				),
			),
			["Invalid or oversized image dimensions: /mock/direct-fail.png"],
		)
	} finally {
		dimensions = [8, 8]
	}
})

const temporary_artwork = "/mock-cache/artwork/.temporary"

function http_failure(
	name: string,
	start: string[],
	finish: string[],
	staged: file_data | null = { size: 100 },
) {
	const uri = `https://example.invalid/${name}`
	let texture: Accessor<unknown> | null = null
	const pending = downloads.length
	cache.set(temporary_artwork, { size: 1 })
	const started = failures(start, () => {
		texture = create_texture_accessor(uri, 40)
	})
	if (downloads.length === pending) {
		assert.equal(texture!(), null)
		assert.equal(cache.has(temporary_artwork), false)
		return started
	}
	if (staged) cache.set(temporary_artwork, staged)
	else cache.delete(temporary_artwork)
	const finished = failures(finish, () => downloads.shift()!(null, {}))
	assert.equal(texture!(), null)
	assert.equal(cache.has(temporary_artwork), false)
	return [...started, ...finished]
}

test("HTTP download failures carry their reason and remove the staged file", () => {
	assert.deepEqual(http_failure("mkdir", ["mkdir"], []), [
		"Cannot create artwork cache",
	])
	assert.deepEqual(http_failure("spawn", ["spawn"], []), ["spawn failed"])
	assert.deepEqual(http_failure("wait", [], ["wait"]), ["wait failed"])
	assert.deepEqual(http_failure("curl", [], ["curl"]), [
		"curl failed for https://example.invalid/curl",
	])
	assert.deepEqual(http_failure("missing", [], [], null), ["missing"])
	assert.deepEqual(
		http_failure("oversized", [], [], { size: 8 * 1024 * 1024 + 1 }),
		["Artwork exceeds 8 MiB"],
	)
	assert.deepEqual(http_failure("move", [], ["move"]), [
		"Failed to publish downloaded artwork",
	])
	assert.deepEqual(http_failure("move-throws", [], ["move-throws"]), [
		"move failed",
	])
})

test("downloaded artwork that cannot be decoded is removed from the cache", () => {
	const published = (name: string) =>
		`/mock-cache/artwork/${`https://example.invalid/${name}`.replace(/\W/g, "a").slice(0, 40).padEnd(40, "b")}`
	assert.deepEqual(http_failure("decode-throws", [], ["file-decode"]), [
		"decode failed",
	])
	assert.equal(cache.has(published("decode-throws")), false)
	dimensions = [9000, 8]
	try {
		assert.deepEqual(http_failure("decode-oversized", [], []), [
			`Invalid or oversized image dimensions: ${published("decode-oversized")}`,
		])
	} finally {
		dimensions = [8, 8]
	}
	assert.equal(cache.has(published("decode-oversized")), false)
})

function logged(active: string[], run: () => void): unknown[][] {
	const errors: unknown[][] = []
	const previous = console.error
	console.error = (...args) => errors.push(args)
	for (const fault of active) faults.add(fault)
	try {
		run()
	} finally {
		faults.clear()
		console.error = previous
	}
	return errors.map(([tag, error]) => [
		tag,
		error === undefined ? undefined : (error as Error).message,
	])
}

function local_failure(name: string, active: string[], steps: string[]) {
	const path = `/mock/local-${name}.png`
	files.set(path, { size: 100 })
	let texture: Accessor<unknown> | null = null
	const messages = logged(active, () => {
		texture = create_texture_accessor(path, 33)
		for (const step of steps) {
			if (step === "read") reads.shift()!.callback(null, {})
			if (step === "decode") decodes.shift()!(null, {})
		}
	})
	assert.equal(texture!(), null)
	assert.equal(reads.length, 0)
	assert.equal(decodes.length, 0)
	return messages
}

test("local load failures carry their reason and close what they opened", () => {
	const key = (name: string) =>
		`textures: Failed to load contain:33:/mock/local-${name}.png:100:1:0:`
	const square = (name: string) => key(name).replace("contain", "square")
	assert.deepEqual(local_failure("start", ["read-start"], []), [
		[square("start"), "read start failed"],
	])
	assert.deepEqual(local_failure("finish", ["read-finish"], ["read"]), [
		[square("finish"), "read failed"],
	])
	const before = closed
	assert.deepEqual(local_failure("decode", ["decode-start"], ["read"]), [
		[square("decode"), "decode start failed"],
	])
	assert.equal(closed, before + 1)
	assert.deepEqual(
		local_failure("decode-close", ["decode-start", "stream-close"], ["read"]),
		[
			[
				"textures: Failed to close /mock/local-decode-close.png",
				"stream close failed",
			],
			[square("decode-close"), "decode start failed"],
		],
	)
	dimensions = [9000, 8]
	try {
		assert.deepEqual(local_failure("giant", [], []), [
			[square("giant"), "Invalid or oversized image dimensions"],
		])
	} finally {
		dimensions = [8, 8]
	}
	assert.deepEqual(local_failure("info", ["file-info"], []), [
		[square("info"), "file info failed"],
	])
	files.set("/mock/local-closing.png", { size: 100 })
	const messages = logged([], () => {
		const texture = create_texture_accessor("/mock/local-closing.png", 34)
		reads.shift()!.callback(null, {})
		faults.add("stream-close")
		decodes.shift()!(null, {})
		assert.deepEqual(texture(), { image: true })
	})
	assert.deepEqual(messages, [
		[
			"textures: Failed to close /mock/local-closing.png",
			"stream close failed",
		],
	])
	assert.equal(key("x").startsWith("textures:"), true)
})

test("invalid file URIs and oversized URIs are refused with a log", () => {
	assert.deepEqual(
		logged([], () =>
			assert.equal(create_texture_accessor("file://[broken", 32)(), null),
		),
		[["textures: Invalid file URI file://[broken", "Invalid URL"]],
	)
	assert.deepEqual(
		logged([], () =>
			assert.equal(
				create_texture_accessor(`https://x.invalid/${"a".repeat(4096)}`, 32)(),
				null,
			),
		),
		[["textures: Image URI exceeds length limit", undefined]],
	)
	assert.equal(create_texture_accessor("file://remote/x.png", 32)(), null)
	assert.equal(create_texture_accessor("ftp://x/y.png", 32)(), null)
	assert.equal(create_texture_accessor("", 32)(), null)
	assert.deepEqual(
		logged([], () =>
			assert.equal(create_texture_accessor("/mock/absent.png", 32)(), null),
		),
		[["textures: Failed to stat /mock/absent.png", "missing"]],
	)
	assert.equal(create_texture_accessor("/mock/absent.png", 1.5)(), null)
})

test("temporary artwork removal ignores a missing file and logs other failures", () => {
	const remove = (active: string[]) =>
		logged(active, () => {
			create_texture_accessor(`https://example.invalid/remove-${active}`, 40)
		})
	faults.clear()
	const tag =
		"textures: Failed to remove temporary artwork /mock-cache/artwork/.temporary"
	const load_tag = (active: string[]) =>
		`textures: Failed to load square:40:https://example.invalid/remove-${active}:`
	assert.deepEqual(remove(["spawn", "delete-missing"]), [
		[load_tag(["spawn", "delete-missing"]), "spawn failed"],
	])
	assert.deepEqual(remove(["spawn", "delete-false"]), [
		[tag, undefined],
		[load_tag(["spawn", "delete-false"]), "spawn failed"],
	])
	assert.deepEqual(remove(["spawn", "delete-throws"]), [
		[tag, "delete failed"],
		[load_tag(["spawn", "delete-throws"]), "spawn failed"],
	])
})

test("the artwork cache evicts the oldest entries beyond its count and size limits", () => {
	const hash = (index: number) => index.toString(16).padStart(40, "0")
	listing.length = 0
	for (let index = 0; index < 130; index++)
		listing.push({ name: hash(index), size: 1, modified: 1000 - index })
	listing.push({ name: "not-a-hash", size: 1, modified: 0 })
	deleted.length = 0
	const closed_before = enumerators_closed
	const uri = "https://example.invalid/prune-count"
	const texture = create_texture_accessor(uri, 40)
	cache.set(temporary_artwork, { size: 100 })
	downloads.shift()!(null, {})
	assert.deepEqual(texture(), { image: true })
	assert.deepEqual(deleted, [
		`/mock-cache/artwork/${hash(129)}`,
		`/mock-cache/artwork/${hash(128)}`,
	])
	assert.equal(enumerators_closed, closed_before + 1)

	listing.length = 0
	listing.push(
		{ name: hash(1), size: 40 * 1024 * 1024, modified: 5 },
		{ name: hash(2), size: 30 * 1024 * 1024, modified: 1 },
		{ name: hash(3), size: 1, modified: 9 },
	)
	deleted.length = 0
	const sized = create_texture_accessor(
		"https://example.invalid/prune-size",
		40,
	)
	cache.set(temporary_artwork, { size: 100 })
	downloads.shift()!(null, {})
	assert.deepEqual(sized(), { image: true })
	assert.deepEqual(deleted, [`/mock-cache/artwork/${hash(2)}`])
	listing.length = 0

	for (const [fault, message] of [
		["enumerate", "enumerate failed"],
		["next-file", "next failed"],
	]) {
		const before = enumerators_closed
		const messages = logged([], () => {
			create_texture_accessor(`https://example.invalid/prune-${fault}`, 40)
			cache.set(temporary_artwork, { size: 100 })
			faults.add(fault)
			downloads.shift()!(null, {})
		})
		assert.deepEqual(messages, [
			["textures: Failed to prune artwork cache", message],
		])
		assert.equal(enumerators_closed, before + (fault === "next-file" ? 1 : 0))
	}
})

test("queued work respects the inline byte budget and the shared queue bound", () => {
	const inline = (length: number) =>
		`data:image/png;base64,${"A".repeat(length)}`
	const textures: Accessor<unknown>[] = []
	let first_inline: Accessor<unknown> | null = null
	const messages = logged([], () => {
		for (let index = 0; index < 4; index++) {
			files.set(`/queue/${index}.png`, { size: 100 })
			textures.push(create_texture_accessor(`/queue/${index}.png`, 32))
		}
		first_inline = create_texture_accessor(inline(9_000_000), 201)
		create_texture_accessor(inline(9_000_000), 202)
		for (let index = 4; index < 67; index++) {
			files.set(`/queue/${index}.png`, { size: 100 })
			textures.push(create_texture_accessor(`/queue/${index}.png`, 32))
		}
		create_texture_accessor("https://example.invalid/queued", 40)
		create_texture_accessor("https://example.invalid/queued", 41)
		create_texture_accessor(inline(7_000_000), 203)
	})
	assert.deepEqual(
		messages.map(([, message]) => message),
		[
			"Inline artwork queue full",
			"Artwork queue full",
			"Artwork queue full",
			"Artwork queue full",
		],
	)
	assert.equal(reads.length, 4)
	while (reads.length) {
		reads.shift()!.callback(null, {})
		decodes.shift()!(null, {})
	}
	for (const texture of textures) assert.deepEqual(texture(), { image: true })
	assert.deepEqual(first_inline!(), { image: true })
	assert.deepEqual(create_texture_accessor(inline(10_000_000), 204)(), {
		image: true,
	})
	assert.equal(downloads.length, 0)
})

test("one pending download accepts at most 128 subscribers", () => {
	const uri = "https://example.invalid/crowded"
	const textures: Accessor<unknown>[] = []
	const messages = logged([], () => {
		for (let size = 1; size <= 129; size++)
			textures.push(create_texture_accessor(uri, size))
	})
	assert.deepEqual(
		messages.map(([, message]) => message),
		["Artwork subscriber queue full"],
	)
	assert.equal(downloads.length, 1)
	cache.set(temporary_artwork, { size: 100 })
	downloads.shift()!(null, {})
	for (const texture of textures.slice(0, 128))
		assert.deepEqual(texture(), { image: true })
	assert.equal(textures[128](), null)
})

test("a fresh cached download is reused without fetching again", () => {
	const uri = "https://example.invalid/fresh"
	const first = create_texture_accessor(uri, 40)
	cache.set(temporary_artwork, { size: 100 })
	downloads.shift()!(null, {})
	assert.deepEqual(first(), { image: true })
	assert.deepEqual(create_texture_accessor(uri, 41)(), { image: true })
	assert.equal(downloads.length, 0)
	const published = [...cache.keys()].find((path) => path.includes("fresh"))!
	cache.set(published, { size: 100, modified: Date.now() / 1000 - 61 })
	create_texture_accessor(uri, 42)
	assert.equal(downloads.length, 1)
	cache.set(temporary_artwork, { size: 100 })
	downloads.shift()!(null, {})
	cache.set(published, {
		size: 8 * 1024 * 1024 + 1,
		modified: Date.now() / 1000,
	})
	create_texture_accessor(uri, 43)
	assert.equal(downloads.length, 1)
	cache.set(temporary_artwork, { size: 100 })
	downloads.shift()!(null, {})
})
