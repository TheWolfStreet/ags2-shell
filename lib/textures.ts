import { createState, type Accessor } from "ags"
import { Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"

import env from "$lib/env"
import { attempt, err, guard, log_error, ok, type result } from "$lib/result"
import {
	is_not_found_error,
	max_image_bytes,
	query_file_signature,
	valid_image_dimensions,
	file_size,
} from "$lib/files"

const { Texture } = Gdk
type fit = "square" | "contain"
type entry = {
	texture: Accessor<Gdk.Texture | null>
	set: (value: Gdk.Texture) => void
	created: number
}
type request = { key: string; size: number; fit: fit; entry: entry }
type local_request = request & { path: string; revision: string }
type signature = { value: string | null; size: number | null; checked: number }
type cached_artwork = { path: string; size: number; modified: number }
type image_uri_kind = "local" | "http" | "data" | "unknown"
type local_image = { kind: "local"; path: string; revision: string }
type image_source = local_image | { kind: "http" } | { kind: "data" }

const signature_cache = new Map<string, signature>()
const square_cache = new Map<string, Gdk.Texture>()
const accessor_cache = new Map<string, entry>()
const pending: Array<() => void> = []
const http_jobs = new Map<string, request[]>()
const cache_dir = `${env.paths.cache.base}/artwork`
const artwork_name = /^[a-f0-9]{40}$/
const max_bytes = 8 * 1024 * 1024
const max_encoded_bytes = (max_bytes * 4) / 3
const max_size = 512
const max_display_size = 8192
const max_pending = 64
const max_active = 4
let active = 0
let inline_bytes_queued = 0
let hidden_drag_texture: Gdk.Texture | null = null

export function classify_image_uri(uri: string): image_uri_kind {
	if (uri.startsWith("/") || uri.startsWith("file://")) return "local"
	if (uri.startsWith("http://") || uri.startsWith("https://")) return "http"
	if (is_inline_image_data(uri)) return "data"
	return "unknown"
}

function is_inline_image_data(uri: string): boolean {
	return (
		uri.startsWith("data:image/") ||
		uri.includes("iVBORw0KGgo") ||
		uri.includes("/9j/")
	)
}

function valid_size(size: number) {
	return Number.isInteger(size) && size >= 1
}

function sha1(text: string) {
	return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, text, -1)
}

function remember<T>(
	cache: Map<string, T>,
	key: string,
	value: T,
	limit: number,
) {
	cache.delete(key)
	cache.set(key, value)
	if (cache.size > limit) cache.delete(cache.keys().next().value!)
}

function local_path(uri: string): string | null {
	if (uri.startsWith("/")) return uri
	const path = attempt(() => Gio.File.new_for_uri(uri).get_path())
	if (!path.ok) {
		console.error(`textures: Invalid file URI ${uri}`, path.err)
		return null
	}
	if (!path.value || !GLib.path_is_absolute(path.value)) return null
	return path.value
}

function file_signature(path: string, refresh = false): signature {
	const now = GLib.get_monotonic_time()
	const cached = signature_cache.get(path)
	if (!refresh && cached && now - cached.checked < 1_000_000) return cached
	const found = query_file_signature(path)
	if (!found.ok) console.error(`textures: Failed to stat ${path}`, found.err)
	const current = found.ok ? found.value : null
	const signature = {
		value: current?.value ?? null,
		size: current?.size ?? null,
		checked: now,
	}
	remember(signature_cache, path, signature, 256)
	return signature
}

export function get_file_size(file_path: string): number | null {
	return file_path ? file_signature(file_path).size : null
}

function readable_image(path: string): result<boolean> {
	const info = attempt(() => GdkPixbuf.Pixbuf.get_file_info(path))
	if (!info.ok) return info
	const [format, width, height] = info.value
	return ok(Boolean(format) && valid_image_dimensions(width, height))
}

function file_pixbuf(path: string, size: number): result<GdkPixbuf.Pixbuf> {
	const readable = readable_image(path)
	if (!readable.ok) return readable
	if (!readable.value)
		return err(new Error(`Invalid or oversized image dimensions: ${path}`))
	return attempt(() =>
		GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size, size, true),
	)
}

function square_texture(
	pixbuf: GdkPixbuf.Pixbuf,
	size: number,
): result<Gdk.Texture> {
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
	if (!scaled) return err(new Error("Failed to scale image"))
	const square = GdkPixbuf.Pixbuf.new(
		GdkPixbuf.Colorspace.RGB,
		true,
		8,
		size,
		size,
	)
	if (!square) return err(new Error("Failed to allocate square image"))
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
	return ok(Texture.new_for_pixbuf(square))
}

function fitted_texture(
	pixbuf: GdkPixbuf.Pixbuf,
	size: number,
	fit: fit,
): result<Gdk.Texture> {
	return guard(() =>
		fit === "square"
			? square_texture(pixbuf, size)
			: ok(Texture.new_for_pixbuf(pixbuf)),
	)
}

function file_texture(
	path: string,
	size: number,
	fit: fit,
): result<Gdk.Texture> {
	const pixbuf = file_pixbuf(path, size)
	if (!pixbuf.ok) return pixbuf
	return fitted_texture(pixbuf.value, size, fit)
}

export function texture_from_file_square_contain(
	file_path: string,
	size: number,
): Gdk.Texture | null {
	if (!valid_size(size)) return null
	const bounded = Math.min(size, max_size)
	const signature = file_signature(file_path, true)
	if (!signature.value || !signature.size) return null
	const key = `${file_path}:${bounded}:${signature.value}`
	const cached = square_cache.get(key)
	if (cached) return cached
	const texture = file_texture(file_path, bounded, "square")
	const tag = `textures.texture_from_file_square_contain: Failed to load ${file_path}`
	if (!log_error(texture, tag)) return null
	remember(square_cache, key, texture.value, 256)
	return texture.value
}

function inline_too_large() {
	return err(new Error("Inline artwork exceeds 8 MiB"))
}

function inline_bytes(uri: string): result<Uint8Array> {
	const is_data_uri = uri.startsWith("data:")
	const comma = uri.indexOf(",")
	const encoded = is_data_uri ? uri.slice(comma + 1) : uri
	if (encoded.length > max_encoded_bytes + 4) return inline_too_large()
	if (is_data_uri && !uri.slice(0, comma).includes(";base64"))
		return err(new Error("Unsupported inline image encoding"))
	const bytes = attempt(() => GLib.base64_decode(encoded.replace(/\s/g, "")))
	if (!bytes.ok) return bytes
	if (bytes.value.length > max_bytes) return inline_too_large()
	return bytes
}

function inline_pixbuf(
	bytes: Uint8Array,
	size: number,
): result<GdkPixbuf.Pixbuf> {
	const loader = GdkPixbuf.PixbufLoader.new()
	let invalid = false
	loader.connect("size-prepared", (_loader, width, height) => {
		if (!valid_image_dimensions(width, height)) invalid = true
		if (invalid) {
			loader.set_size(1, 1)
			return
		}
		const scale = Math.min(size / width, size / height, 1)
		loader.set_size(
			Math.max(1, Math.round(width * scale)),
			Math.max(1, Math.round(height * scale)),
		)
	})
	const written = attempt(() => loader.write_bytes(new GLib.Bytes(bytes)))
	const closed = attempt(() => loader.close())
	if (!closed.ok) return closed
	if (!written.ok) return written
	if (invalid)
		return err(new Error("Invalid or oversized inline image dimensions"))
	const pixbuf = loader.get_pixbuf()
	if (!pixbuf) return err(new Error("Failed to decode inline image"))
	return ok(pixbuf)
}

function inline_texture(
	uri: string,
	size: number,
	fit: fit,
): result<Gdk.Texture> {
	const bytes = inline_bytes(uri)
	if (!bytes.ok) return bytes
	const pixbuf = inline_pixbuf(bytes.value, size)
	if (!pixbuf.ok) return pixbuf
	return fitted_texture(pixbuf.value, size, fit)
}

function list_cached_artwork(): cached_artwork[] {
	const files: cached_artwork[] = []
	const enumerator = Gio.File.new_for_path(cache_dir).enumerate_children(
		"standard::name,standard::size,time::modified",
		Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
		null,
	)
	try {
		while (true) {
			const info = enumerator.next_file(null)
			if (!info) break
			if (!artwork_name.test(info.get_name())) continue
			files.push({
				path: `${cache_dir}/${info.get_name()}`,
				size: info.get_size(),
				modified: info.get_attribute_uint64("time::modified"),
			})
		}
	} finally {
		enumerator.close(null)
	}
	return files
}

function evict_oldest(files: cached_artwork[]) {
	files.sort((a, b) => a.modified - b.modified)
	let total = files.reduce((sum, file) => sum + file.size, 0)
	while (files.length > 128 || total > 64 * 1024 * 1024) {
		const file = files.shift()!
		Gio.File.new_for_path(file.path).delete(null)
		total -= file.size
	}
}

function prune_disk() {
	const pruned = attempt(() => evict_oldest(list_cached_artwork()))
	log_error(pruned, "textures: Failed to prune artwork cache")
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

function deliver({ key, entry }: request, loaded: result<Gdk.Texture | null>) {
	if (!loaded.ok) console.error(`textures: Failed to load ${key}`, loaded.err)
	if (loaded.ok && loaded.value) entry.set(loaded.value)
	else if (accessor_cache.get(key) === entry) accessor_cache.delete(key)
}

function settle(request: request, loaded: result<Gdk.Texture | null>) {
	deliver(request, loaded)
	finished()
}

function queue_full(request: request) {
	deliver(request, err(new Error("Artwork queue full")))
}

function close_local_stream(path: string, stream: Gio.InputStream) {
	const closed = attempt(() => stream.close(null))
	if (!closed.ok) console.error(`textures: Failed to close ${path}`, closed.err)
}

function finish_local(
	job: local_request,
	stream: Gio.InputStream,
	decoded: Gio.AsyncResult,
) {
	const pixbuf = attempt(() => GdkPixbuf.Pixbuf.new_from_stream_finish(decoded))
	const image = pixbuf.ok
		? fitted_texture(pixbuf.value, job.size, job.fit)
		: pixbuf
	close_local_stream(job.path, stream)
	const current = file_signature(job.path, true).value === job.revision
	settle(job, current ? image : ok(null))
}

function decode_local(
	job: local_request,
	file: Gio.File,
	opened: Gio.AsyncResult,
): result<void> {
	const stream = attempt(() => file.read_finish(opened))
	if (!stream.ok) return stream
	const decoding = attempt(() =>
		GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
			stream.value,
			job.size,
			job.size,
			true,
			null,
			(_source, decoded) => finish_local(job, stream.value, decoded),
		),
	)
	if (!decoding.ok) close_local_stream(job.path, stream.value)
	return decoding
}

function open_local(job: local_request): result<void> {
	const readable = readable_image(job.path)
	if (!readable.ok) return readable
	if (!readable.value)
		return err(new Error("Invalid or oversized image dimensions"))
	const file = Gio.File.new_for_path(job.path)
	return attempt(() =>
		file.read_async(GLib.PRIORITY_DEFAULT, null, (_source, opened) => {
			const decoding = decode_local(job, file, opened)
			if (!decoding.ok) settle(job, decoding)
		}),
	)
}

function load_local(job: local_request) {
	const opened = open_local(job)
	if (!opened.ok) settle(job, opened)
}

function is_fresh_download(path: string): boolean {
	const info = attempt(() =>
		Gio.File.new_for_path(path).query_info(
			"standard::size,time::modified",
			Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
			null,
		),
	)
	if (!info.ok) return false
	const size = info.value.get_size()
	const age =
		Date.now() / 1000 - info.value.get_attribute_uint64("time::modified")
	return size > 0 && size <= max_bytes && age <= 60
}

function start_download(
	uri: string,
	temporary: string,
): result<Gio.Subprocess> {
	if (GLib.mkdir_with_parents(cache_dir, 0o700) !== 0)
		return err(new Error("Cannot create artwork cache"))
	return attempt(() =>
		Gio.Subprocess.new(
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
		),
	)
}

function finish_download(
	process: Gio.Subprocess,
	result: Gio.AsyncResult,
	uri: string,
	temporary: string,
	path: string,
): result<void> {
	const waited = attempt(() => process.wait_finish(result))
	if (!waited.ok) return waited
	if (!process.get_successful()) return err(new Error(`curl failed for ${uri}`))
	const file = Gio.File.new_for_path(temporary)
	const size = file_size(temporary)
	if (!size.ok) return size
	if (!size.value || size.value > max_bytes)
		return err(new Error("Artwork exceeds 8 MiB"))
	const moved = attempt(() =>
		file.move(
			Gio.File.new_for_path(path),
			Gio.FileCopyFlags.OVERWRITE,
			null,
			null,
		),
	)
	if (!moved.ok) return moved
	if (!moved.value)
		return err(new Error("Failed to publish downloaded artwork"))
	return ok(undefined)
}

function remove_temporary(path: string) {
	const removed = attempt(() => Gio.File.new_for_path(path).delete(null))
	const tag = `textures: Failed to remove temporary artwork ${path}`
	if (removed.ok) {
		if (!removed.value) console.error(tag)
		return
	}
	if (is_not_found_error(removed.err)) return
	console.error(tag, removed.err)
}

function deliver_download(subscribers: request[], path: string) {
	let invalid = false
	for (const subscriber of subscribers) {
		const texture = file_texture(path, subscriber.size, subscriber.fit)
		if (!texture.ok) invalid = true
		deliver(subscriber, texture)
	}
	if (!invalid) return
	const removed = attempt(() => Gio.File.new_for_path(path).delete(null))
	log_error(removed, `textures: Failed to remove invalid artwork ${path}`)
}

function complete_http(uri: string, downloaded: result<string>) {
	const subscribers = http_jobs.get(uri) ?? []
	http_jobs.delete(uri)
	if (downloaded.ok) deliver_download(subscribers, downloaded.value)
	else for (const subscriber of subscribers) deliver(subscriber, downloaded)
	finished()
}

function fail_download(uri: string, temporary: string, failure: result<never>) {
	remove_temporary(temporary)
	complete_http(uri, failure)
}

function download(uri: string, path: string) {
	const temporary = `${cache_dir}/.${GLib.uuid_string_random()}`
	const process = start_download(uri, temporary)
	if (!process.ok) {
		fail_download(uri, temporary, process)
		return
	}
	process.value.wait_async(null, (_source, result) => {
		const downloaded = finish_download(
			process.value,
			result,
			uri,
			temporary,
			path,
		)
		if (!downloaded.ok) {
			fail_download(uri, temporary, downloaded)
			return
		}
		prune_disk()
		complete_http(uri, ok(path))
	})
}

function load_http(uri: string) {
	if (!http_jobs.get(uri)?.length) {
		http_jobs.delete(uri)
		finished()
		return
	}
	const path = `${cache_dir}/${sha1(uri)}`
	if (is_fresh_download(path)) complete_http(uri, ok(path))
	else download(uri, path)
}

function start_http(uri: string, request: request) {
	http_jobs.set(uri, [request])
	if (enqueue(() => load_http(uri))) return
	http_jobs.delete(uri)
	queue_full(request)
}

function request_http(uri: string, request: request) {
	const subscribers = http_jobs.get(uri)
	if (!subscribers) start_http(uri, request)
	else if (subscribers.length >= 128)
		deliver(request, err(new Error("Artwork subscriber queue full")))
	else subscribers.push(request)
}

function decode_inline(uri: string, request: request) {
	deliver(request, inline_texture(uri, request.size, request.fit))
	inline_bytes_queued -= uri.length
	finished()
}

function request_inline(uri: string, request: request) {
	if (inline_bytes_queued + uri.length > 16 * 1024 * 1024) {
		deliver(request, err(new Error("Inline artwork queue full")))
		return
	}
	inline_bytes_queued += uri.length
	if (enqueue(() => decode_inline(uri, request))) return
	inline_bytes_queued -= uri.length
	queue_full(request)
}

function request_local(image: local_image, request: request) {
	const job = { ...request, path: image.path, revision: image.revision }
	if (!enqueue(() => load_local(job))) queue_full(request)
}

function request_texture(uri: string, source: image_source, request: request) {
	if (source.kind === "http") request_http(uri, request)
	else if (source.kind === "data") request_inline(uri, request)
	else request_local(source, request)
}

function exceeds_uri_limit(uri: string, kind: image_uri_kind) {
	if (kind === "data") return uri.length > max_encoded_bytes + 128
	if (kind === "http") return uri.length > 4096
	return false
}

function resolve_local(uri: string): local_image | null {
	const path = local_path(uri)
	if (!path) return null
	const signature = file_signature(path, true)
	if (signature.size && signature.size > max_image_bytes) {
		console.error("textures: Local image exceeds 64 MiB")
		return null
	}
	if (!signature.value) return null
	return { kind: "local", path, revision: signature.value }
}

function image_source(uri: string): image_source | null {
	const kind = classify_image_uri(uri)
	if (kind === "unknown") return null
	if (exceeds_uri_limit(uri, kind)) {
		console.error("textures: Image URI exceeds length limit")
		return null
	}
	if (kind === "local") return resolve_local(uri)
	return { kind }
}

function texture_key(
	uri: string,
	source: image_source,
	size: number,
	fit: fit,
) {
	const identifier = source.kind === "data" ? sha1(uri) : uri
	const revision = source.kind === "local" ? source.revision : ""
	return `${fit}:${size}:${identifier}:${revision}`
}

function empty_texture() {
	return createState<Gdk.Texture | null>(null)[0]
}

function new_request(key: string, size: number, fit: fit, now: number) {
	const [texture, set] = createState<Gdk.Texture | null>(null)
	return { key, size, fit, entry: { texture, set, created: now } }
}

export function create_texture_accessor(
	uri: string,
	size: number,
	fit: fit = "square",
): Accessor<Gdk.Texture | null> {
	if (!uri || !valid_size(size)) return empty_texture()
	const source = image_source(uri)
	if (!source) return empty_texture()
	const bounded = Math.min(size, max_size)
	const key = texture_key(uri, source, bounded, fit)
	const now = GLib.get_monotonic_time()
	const cached = accessor_cache.get(key)
	if (cached && (source.kind !== "http" || now - cached.created <= 60_000_000))
		return cached.texture
	const request = new_request(key, bounded, fit, now)
	remember(accessor_cache, key, request.entry, 64)
	request_texture(uri, source, request)
	return request.entry.texture
}

export function create_display_texture(
	uri: string,
	size: number,
): Accessor<Gdk.Texture | null> {
	if (!uri || !valid_size(size)) return empty_texture()
	const source = image_source(uri)
	if (!source) return empty_texture()
	const bounded = Math.min(size, max_display_size)
	const key = texture_key(uri, source, bounded, "contain")
	const request = new_request(
		key,
		bounded,
		"contain",
		GLib.get_monotonic_time(),
	)
	request_texture(uri, source, request)
	return request.entry.texture
}

export function hidden_drag_icon(): Gdk.Texture {
	if (!hidden_drag_texture)
		hidden_drag_texture = Gdk.MemoryTexture.new(
			1,
			1,
			Gdk.MemoryFormat.R8G8B8A8,
			new Uint8Array([0, 0, 0, 0]),
			4,
		)
	return hidden_drag_texture
}
