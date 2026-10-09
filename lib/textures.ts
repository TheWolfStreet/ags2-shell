import { createState, type Accessor } from "ags"
import { Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"

import env from "$lib/env"
import { attempt } from "$lib/result"

const { Texture } = Gdk
type Entry = {
	texture: Accessor<Gdk.Texture | null>
	set: (value: Gdk.Texture) => void
	created: number
}
const signature_cache = new Map<
	string,
	{ value: string | null; size: number | null; checked: number }
>()
const square_cache = new Map<string, Gdk.Texture>()
const accessor_cache = new Map<string, Entry>()
const pending: Array<() => void> = []
const http_jobs = new Map<
	string,
	Array<{ key: string; size: number; fit: "square" | "contain"; entry: Entry }>
>()
const cache_dir = `${env.paths.cache.base}/artwork`
const max_bytes = 8 * 1024 * 1024
const max_local_bytes = 64 * 1024 * 1024
const max_dimension = 8192
const max_pixels = 40_000_000
const max_size = 512
const max_pending = 64
const max_active = 4
let active = 0
let inline_bytes_queued = 0

type ImageUriKind = "local" | "http" | "data" | "unknown"

export function classify_image_uri(uri: string): ImageUriKind {
	if (uri.startsWith("/") || uri.startsWith("file://")) return "local"
	if (uri.startsWith("http://") || uri.startsWith("https://")) return "http"
	if (is_inline_image_data(uri)) return "data"
	return "unknown"
}

function local_path(uri: string): string | null {
	if (uri.startsWith("/")) return uri
	const result = attempt(() => Gio.File.new_for_uri(uri).get_path())
	if (!result.ok) {
		console.error(`textures: Invalid file URI ${uri}`, result.err)
		return null
	}
	return result.value && GLib.path_is_absolute(result.value)
		? result.value
		: null
}

function file_signature(path: string, refresh = false) {
	const now = GLib.get_monotonic_time()
	const cached = signature_cache.get(path)
	if (!refresh && cached && now - cached.checked < 1_000_000) return cached
	let value: string | null = null
	let size: number | null = null
	const result = attempt(() =>
		Gio.File.new_for_path(path).query_info(
			"standard::size,time::modified,time::modified-usec,etag::value",
			Gio.FileQueryInfoFlags.NONE,
			null,
		),
	)
	if (result.ok) {
		size = result.value.get_size()
		value = [
			size,
			result.value.get_attribute_uint64("time::modified"),
			result.value.get_attribute_uint32("time::modified-usec"),
			result.value.get_attribute_string("etag::value") ?? "",
		].join(":")
	} else if (
		!(
			result.err instanceof GLib.Error &&
			result.err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)
		)
	) {
		console.error(`textures: Failed to stat ${path}`, result.err)
	}
	const signature = { value, size, checked: now }
	if (signature_cache.has(path)) signature_cache.delete(path)
	signature_cache.set(path, signature)
	if (signature_cache.size > 256)
		signature_cache.delete(signature_cache.keys().next().value!)
	return signature
}

export function get_file_size(file_path: string): number | null {
	return file_path ? file_signature(file_path).size : null
}

function valid_dimensions(width: number, height: number) {
	return (
		width > 0 &&
		height > 0 &&
		width <= max_dimension &&
		height <= max_dimension &&
		width * height <= max_pixels
	)
}

function file_pixbuf(path: string, width: number, height: number) {
	const [format, source_width, source_height] =
		GdkPixbuf.Pixbuf.get_file_info(path)
	if (!format || !valid_dimensions(source_width, source_height))
		throw new Error(`Invalid or oversized image dimensions: ${path}`)
	return GdkPixbuf.Pixbuf.new_from_file_at_scale(path, width, height, true)
}

function square_texture(pixbuf: GdkPixbuf.Pixbuf, size: number): Gdk.Texture {
	const width = pixbuf.get_width()
	const height = pixbuf.get_height()
	const scale = Math.min(size / width, size / height)
	const dest_width = Math.max(1, Math.round(width * scale))
	const dest_height = Math.max(1, Math.round(height * scale))
	const scaled = pixbuf.scale_simple(
		dest_width,
		dest_height,
		GdkPixbuf.InterpType.BILINEAR,
	)
	if (!scaled) throw new Error("Failed to scale image")
	const square = GdkPixbuf.Pixbuf.new(
		GdkPixbuf.Colorspace.RGB,
		true,
		8,
		size,
		size,
	)
	if (!square) throw new Error("Failed to allocate square image")
	square.fill(0x00000000)
	scaled.copy_area(
		0,
		0,
		dest_width,
		dest_height,
		square,
		Math.floor((size - dest_width) / 2),
		Math.floor((size - dest_height) / 2),
	)
	return Texture.new_for_pixbuf(square)
}

function fitted_texture(
	pixbuf: GdkPixbuf.Pixbuf,
	size: number,
	fit: "square" | "contain",
) {
	return fit === "square"
		? square_texture(pixbuf, size)
		: Texture.new_for_pixbuf(pixbuf)
}

function remember_square(key: string, texture: Gdk.Texture) {
	if (square_cache.has(key)) square_cache.delete(key)
	square_cache.set(key, texture)
	if (square_cache.size > 256)
		square_cache.delete(square_cache.keys().next().value!)
}

export function texture_from_file_square_contain(
	file_path: string,
	size: number,
): Gdk.Texture | null {
	if (!Number.isInteger(size) || size < 1) return null
	size = Math.min(size, max_size)
	const signature = file_signature(file_path, true)
	if (!signature.value || !signature.size) return null
	const key = `${file_path}:${size}:${signature.value}`
	const cached = square_cache.get(key)
	if (cached) return cached
	const result = attempt(() =>
		square_texture(file_pixbuf(file_path, size, size), size),
	)
	if (!result.ok) {
		console.error(
			`textures.textureFromFileSquareContain: Failed to load ${file_path}`,
			result.err,
		)
		return null
	}
	remember_square(key, result.value)
	return result.value
}

function is_inline_image_data(uri: string): boolean {
	return (
		uri.startsWith("data:image/") ||
		uri.includes("iVBORw0KGgo") ||
		uri.includes("/9j/")
	)
}

function inline_texture(uri: string, size: number, fit: "square" | "contain") {
	const encoded = uri.startsWith("data:")
		? uri.slice(uri.indexOf(",") + 1)
		: uri
	if (encoded.length > (max_bytes * 4) / 3 + 4)
		throw new Error("Inline artwork exceeds 8 MiB")
	if (
		uri.startsWith("data:") &&
		!uri.slice(0, uri.indexOf(",")).includes(";base64")
	)
		throw new Error("Unsupported inline image encoding")
	const bytes = GLib.base64_decode(encoded.replace(/\s/g, ""))
	if (bytes.length > max_bytes) throw new Error("Inline artwork exceeds 8 MiB")
	const loader = GdkPixbuf.PixbufLoader.new()
	let invalid = false
	loader.connect("size-prepared", (_loader, width, height) => {
		if (!valid_dimensions(width, height)) invalid = true
		const scale = Math.min(size / width, size / height, 1)
		loader.set_size(
			invalid ? 1 : Math.max(1, Math.round(width * scale)),
			invalid ? 1 : Math.max(1, Math.round(height * scale)),
		)
	})
	try {
		loader.write_bytes(new GLib.Bytes(bytes))
	} finally {
		loader.close()
	}
	if (invalid) throw new Error("Invalid or oversized inline image dimensions")
	const pixbuf = loader.get_pixbuf()
	if (!pixbuf) throw new Error("Failed to decode inline image")
	return fitted_texture(pixbuf, size, fit)
}

function prune_disk() {
	const result = attempt(() => {
		const files: Array<{ path: string; size: number; modified: number }> = []
		const enumerator = Gio.File.new_for_path(cache_dir).enumerate_children(
			"standard::name,standard::size,time::modified",
			Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
			null,
		)
		try {
			let info: Gio.FileInfo | null
			while ((info = enumerator.next_file(null))) {
				if (!/^[a-f0-9]{40}$/.test(info.get_name())) continue
				files.push({
					path: `${cache_dir}/${info.get_name()}`,
					size: info.get_size(),
					modified: info.get_attribute_uint64("time::modified"),
				})
			}
		} finally {
			enumerator.close(null)
		}
		files.sort((a, b) => a.modified - b.modified)
		let total = files.reduce((sum, file) => sum + file.size, 0)
		while (files.length > 128 || total > 64 * 1024 * 1024) {
			const file = files.shift()!
			Gio.File.new_for_path(file.path).delete(null)
			total -= file.size
		}
	})
	if (!result.ok)
		console.error("textures: Failed to prune artwork cache", result.err)
}

function enqueue(job: () => void) {
	if (pending.length >= max_pending) return false
	pending.push(job)
	pump()
	return true
}

function pump() {
	while (active < max_active && pending.length) {
		active++
		pending.shift()!()
	}
}

function finished() {
	active--
	pump()
}

function deliver(
	key: string,
	entry: Entry,
	texture: Gdk.Texture | null,
	error?: unknown,
) {
	if (error) console.error(`textures: Failed to load ${key}`, error)
	if (texture) entry.set(texture)
	else if (accessor_cache.get(key) === entry) accessor_cache.delete(key)
}

function load_local(
	path: string,
	size: number,
	fit: "square" | "contain",
	key: string,
	entry: Entry,
	revision: string,
) {
	const file = Gio.File.new_for_path(path)
	const dimensions = attempt(() => GdkPixbuf.Pixbuf.get_file_info(path))
	if (
		!dimensions.ok ||
		!dimensions.value[0] ||
		!valid_dimensions(dimensions.value[1], dimensions.value[2])
	) {
		deliver(
			key,
			entry,
			null,
			dimensions.ok
				? new Error("Invalid or oversized image dimensions")
				: dimensions.err,
		)
		finished()
		return
	}
	const opened = attempt(() =>
		file.read_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
			const stream_result = attempt(() => file.read_finish(result))
			if (!stream_result.ok) {
				deliver(key, entry, null, stream_result.err)
				finished()
				return
			}
			const stream = stream_result.value
			const decoded = attempt(() =>
				GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
					stream,
					size,
					size,
					true,
					null,
					(_source, pixbuf_result) => {
						const image = attempt(() =>
							fitted_texture(
								GdkPixbuf.Pixbuf.new_from_stream_finish(pixbuf_result),
								size,
								fit,
							),
						)
						const closed = attempt(() => stream.close(null))
						if (!closed.ok)
							console.error(`textures: Failed to close ${path}`, closed.err)
						if (file_signature(path, true).value === revision)
							deliver(
								key,
								entry,
								image.ok ? image.value : null,
								image.ok ? undefined : image.err,
							)
						else deliver(key, entry, null)
						finished()
					},
				),
			)
			if (!decoded.ok) {
				const closed = attempt(() => stream.close(null))
				if (!closed.ok)
					console.error(`textures: Failed to close ${path}`, closed.err)
				deliver(key, entry, null, decoded.err)
				finished()
			}
		}),
	)
	if (!opened.ok) {
		deliver(key, entry, null, opened.err)
		finished()
	}
}

function load_http(uri: string) {
	if (!http_jobs.get(uri)?.length) {
		http_jobs.delete(uri)
		finished()
		return
	}
	const path = `${cache_dir}/${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, uri, -1)}`
	const cache = Gio.File.new_for_path(path)
	const fresh = attempt(() =>
		cache.query_info(
			"standard::size,time::modified",
			Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
			null,
		),
	)
	if (
		fresh.ok &&
		fresh.value.get_size() > 0 &&
		fresh.value.get_size() <= max_bytes &&
		Date.now() / 1000 - fresh.value.get_attribute_uint64("time::modified") <= 60
	) {
		complete_http(uri, path)
		return
	}
	const temporary = `${cache_dir}/.${GLib.uuid_string_random()}`
	const started = attempt(() => {
		if (GLib.mkdir_with_parents(cache_dir, 0o700) !== 0)
			throw new Error("Cannot create artwork cache")
		const process = Gio.Subprocess.new(
			[
				"curl",
				"--fail",
				"--silent",
				"--location",
				"--proto",
				"=http,https",
				"--proto-redir",
				"=http,https",
				"--connect-timeout",
				"5",
				"--max-time",
				"15",
				"--max-filesize",
				String(max_bytes),
				"--output",
				temporary,
				uri,
			],
			Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
		)
		process.wait_async(null, (_source, result) => {
			const downloaded = attempt(() => {
				process.wait_finish(result)
				if (!process.get_successful()) throw new Error(`curl failed for ${uri}`)
				const info = Gio.File.new_for_path(temporary).query_info(
					"standard::size",
					Gio.FileQueryInfoFlags.NONE,
					null,
				)
				if (!info.get_size() || info.get_size() > max_bytes)
					throw new Error("Artwork exceeds 8 MiB")
				if (
					!Gio.File.new_for_path(temporary).move(
						cache,
						Gio.FileCopyFlags.OVERWRITE,
						null,
						null,
					)
				)
					throw new Error("Failed to publish downloaded artwork")
			})
			if (!downloaded.ok) {
				remove_temporary(temporary)
				complete_http(uri, null, downloaded.err)
			} else {
				prune_disk()
				complete_http(uri, path)
			}
		})
	})
	if (!started.ok) {
		remove_temporary(temporary)
		complete_http(uri, null, started.err)
	}
}

function remove_temporary(path: string) {
	const removed = attempt(() => Gio.File.new_for_path(path).delete(null))
	if (removed.ok) {
		if (!removed.value)
			console.error(`textures: Failed to remove temporary artwork ${path}`)
	} else if (
		!(
			removed.err instanceof GLib.Error &&
			removed.err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)
		)
	) {
		console.error(
			`textures: Failed to remove temporary artwork ${path}`,
			removed.err,
		)
	}
}

function complete_http(uri: string, path: string | null, error?: unknown) {
	const subscribers = http_jobs.get(uri) ?? []
	http_jobs.delete(uri)
	let invalid = false
	for (const { key, size, fit, entry } of subscribers) {
		const decoded = path
			? attempt(() => fitted_texture(file_pixbuf(path, size, size), size, fit))
			: null
		if (decoded && !decoded.ok) invalid = true
		deliver(
			key,
			entry,
			decoded?.ok ? decoded.value : null,
			decoded && !decoded.ok ? decoded.err : error,
		)
	}
	if (invalid && path) {
		const removed = attempt(() => Gio.File.new_for_path(path).delete(null))
		if (!removed.ok)
			console.error(
				`textures: Failed to remove invalid artwork ${path}`,
				removed.err,
			)
	}
	finished()
}

export function create_texture_accessor(
	uri: string,
	size: number,
	fit: "square" | "contain" = "square",
): Accessor<Gdk.Texture | null> {
	const empty = () => createState<Gdk.Texture | null>(null)[0]
	if (!uri || !Number.isInteger(size) || size < 1) return empty()
	size = Math.min(size, max_size)
	const kind = classify_image_uri(uri)
	if (kind === "unknown") return empty()
	if (
		(kind === "data" && uri.length > (max_bytes * 4) / 3 + 128) ||
		(kind === "http" && uri.length > 4096)
	) {
		console.error("textures: Image URI exceeds length limit")
		return empty()
	}
	const path = kind === "local" ? local_path(uri) : null
	if (kind === "local" && !path) return empty()
	const signature = path ? file_signature(path, true) : null
	if (signature?.size && signature.size > max_local_bytes) {
		console.error("textures: Local image exceeds 64 MiB")
		return empty()
	}
	const revision = signature?.value ?? null
	if (path && !revision) return empty()
	const identifier =
		kind === "data"
			? GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, uri, -1)
			: uri
	const key = `${fit}:${size}:${identifier}:${revision ?? ""}`
	const now = GLib.get_monotonic_time()
	const cached = accessor_cache.get(key)
	if (cached && (kind !== "http" || now - cached.created <= 60_000_000))
		return cached.texture
	const [texture, set] = createState<Gdk.Texture | null>(null)
	const entry: Entry = { texture, set, created: now }
	accessor_cache.delete(key)
	accessor_cache.set(key, entry)
	if (accessor_cache.size > 64) {
		const oldest = accessor_cache.keys().next().value!
		accessor_cache.delete(oldest)
	}
	if (kind === "http") {
		const subscribers = http_jobs.get(uri)
		if (subscribers) {
			if (subscribers.length >= 128)
				deliver(key, entry, null, new Error("Artwork subscriber queue full"))
			else subscribers.push({ key, size, fit, entry })
		} else {
			http_jobs.set(uri, [{ key, size, fit, entry }])
			if (!enqueue(() => load_http(uri))) {
				http_jobs.delete(uri)
				deliver(key, entry, null, new Error("Artwork queue full"))
			}
		}
	} else if (path) {
		if (!enqueue(() => load_local(path, size, fit, key, entry, revision!)))
			deliver(key, entry, null, new Error("Artwork queue full"))
	} else {
		if (inline_bytes_queued + uri.length > 16 * 1024 * 1024) {
			deliver(key, entry, null, new Error("Inline artwork queue full"))
			return texture
		}
		inline_bytes_queued += uri.length
		if (
			!enqueue(() => {
				const result = attempt(() => inline_texture(uri, size, fit))
				deliver(
					key,
					entry,
					result.ok ? result.value : null,
					result.ok ? undefined : result.err,
				)
				inline_bytes_queued -= uri.length
				finished()
			})
		) {
			inline_bytes_queued -= uri.length
			deliver(key, entry, null, new Error("Artwork queue full"))
		}
	}
	return texture
}

export const create_square_texture_accessor = create_texture_accessor

let hidden_drag_texture: Gdk.Texture | null = null

export function hidden_drag_icon(): Gdk.Texture {
	return (hidden_drag_texture ??= Gdk.MemoryTexture.new(
		1,
		1,
		Gdk.MemoryFormat.R8G8B8A8,
		new Uint8Array([0, 0, 0, 0]),
		4,
	))
}
