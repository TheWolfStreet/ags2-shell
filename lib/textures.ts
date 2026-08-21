// Loads and caches images from files, URLs, and embedded data.

import { Accessor, createState } from "ags"
import { Gdk } from "ags/gtk4"
import { idle, timeout } from "ags/time"

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"

import env from "$lib/env"
import { attempt } from "$lib/result"

const { Texture } = Gdk

type FileSignature = {
	size: number
	modified: number
}

type CachedSignature = {
	signature: FileSignature | null
	checkedAtUs: number
}

const SQUARE_TEXTURE_CACHE_LIMIT = 256
const FILE_SIGNATURE_CACHE_TTL_US = 1_000_000
const HTTP_ART_CACHE_TTL_SECONDS = 60
const SQUARE_TEXTURE_DISK_CACHE_DIR = env.paths.cache.thumbnails
const MPRIS_ART_CACHE_DIR = `${GLib.get_user_cache_dir()}/astal/mpris`
// Memory caches are bounded and evict their oldest entries; async accessors use FIFO.
const squareContainTextureCache = new Map<string, { signature: string, texture: Gdk.Texture }>()
const fileSignatureCache = new Map<string, CachedSignature>()

export type ImageUriKind = "local" | "http" | "data" | "unknown"

export function classifyImageUri(uri: string): ImageUriKind {
	if (uri.startsWith("/") || uri.startsWith("file://")) return "local"
	if (uri.startsWith("http://") || uri.startsWith("https://")) return "http"
	if (isInlineImageData(uri)) return "data"
	return "unknown"
}

function normalizeLocalImagePath(uri: string) {
	return uri.startsWith("file://") ? uri.slice(7) : uri
}

export function getFileSize(filePath: string): number | null {
	const signature = getFileSignature(filePath)
	return signature ? signature.size : null
}

function getFileSignature(filePath: string): FileSignature | null {
	if (!filePath)
		return null

	const nowUs = GLib.get_monotonic_time()
	const cached = fileSignatureCache.get(filePath)
	if (cached && nowUs - cached.checkedAtUs <= FILE_SIGNATURE_CACHE_TTL_US) {
		return cached.signature
	}

	const result = attempt(() => {
		const info = Gio.File.new_for_path(filePath).query_info(
			"standard::size,time::modified",
			Gio.FileQueryInfoFlags.NONE,
			null,
		)
		return {
			size: info.get_size(),
			modified: info.get_attribute_uint64("time::modified"),
		}
	})

	const signature = result.ok ? result.value : null
	fileSignatureCache.set(filePath, { signature, checkedAtUs: nowUs })
	return signature
}

function rememberSquareTexture(key: string, signature: string, texture: Gdk.Texture) {
	if (squareContainTextureCache.has(key)) {
		squareContainTextureCache.delete(key)
	}

	squareContainTextureCache.set(key, { signature, texture })

	if (squareContainTextureCache.size > SQUARE_TEXTURE_CACHE_LIMIT) {
		const oldest = squareContainTextureCache.keys().next().value
		if (oldest) {
			squareContainTextureCache.delete(oldest)
		}
	}
}

function ensureSquareTextureCacheDir(size: number) {
	const dirPath = `${SQUARE_TEXTURE_DISK_CACHE_DIR}/${size}`
	GLib.mkdir_with_parents(dirPath, 0o755)
	return dirPath
}

function getSquareTextureDiskCachePath(filePath: string, size: number, signatureKey: string) {
	const dirPath = ensureSquareTextureCacheDir(size)
	const fileHash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, filePath, -1)
	const normalizedSignature = signatureKey.replace(/[^0-9a-zA-Z._-]/g, "-")
	return `${dirPath}/${fileHash}-${normalizedSignature}.png`
}

function loadSquareTextureFromDiskCache(cachePath: string) {
	if (!GLib.file_test(cachePath, GLib.FileTest.EXISTS))
		return null

	return textureFromFile(cachePath)
}

export function textureFromFile(filePath: string, width?: number, height?: number): Gdk.Texture | null {
	if (!getFileSize(filePath)) {
		return null
	}

	const primary = attempt(() => {
		let pixbuf = GdkPixbuf.Pixbuf.new_from_file(filePath)
		if (width && height)
			pixbuf = pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)!
		return Texture.new_for_pixbuf(pixbuf)
	})
	if (primary.ok) return primary.value

	const fallback = attempt(() => Texture.new_from_filename(filePath))
	if (fallback.ok) return fallback.value

	console.error(`textures.textureFromFile: Failed to load ${filePath}`, new Error("All texture decoders failed", {
		cause: { primary: primary.err, fallback: fallback.err },
	}))
	return null
}

export function textureFromFileSquareContain(filePath: string, size: number): Gdk.Texture | null {
	if (!getFileSize(filePath)) {
		return null
	}

	const signature = getFileSignature(filePath)
	const cacheKey = signature ? `${filePath}:${size}` : null
	const signatureKey = signature ? `${signature.size}:${signature.modified}` : null
	const diskCachePath = signature && signatureKey
		? getSquareTextureDiskCachePath(filePath, size, signatureKey)
		: null

	if (cacheKey && signatureKey) {
		const cached = squareContainTextureCache.get(cacheKey)
		if (cached && cached.signature === signatureKey)
			return cached.texture
	}

	if (cacheKey && signatureKey && diskCachePath) {
		const diskCachedTexture = loadSquareTextureFromDiskCache(diskCachePath)
		if (diskCachedTexture) {
			rememberSquareTexture(cacheKey, signatureKey, diskCachedTexture)
			return diskCachedTexture
		}
	}

	const result = attempt(() => {
		const source = GdkPixbuf.Pixbuf.new_from_file_at_scale(filePath, size, size, true)
		const square = pixbufSquareContain(source, size)
		if (!square)
			return null

		if (diskCachePath) {
			const saved = attempt(() => square.savev(diskCachePath, "png", [], []))
			if (!saved.ok)
				console.error(`textures.textureFromFileSquareContain: Failed to cache ${filePath}`, saved.err)
		}

		const texture = Texture.new_for_pixbuf(square)
		if (texture && cacheKey && signatureKey)
			rememberSquareTexture(cacheKey, signatureKey, texture)
		return texture
	})

	if (!result.ok) {
		console.error(`textures.textureFromFileSquareContain: Failed to load ${filePath}`, result.err)
		return null
	}
	return result.value
}

function pixbufSquareContain(source: GdkPixbuf.Pixbuf, size: number): GdkPixbuf.Pixbuf | null {
	const result = attempt(() => {
		const srcW = source.get_width()
		const srcH = source.get_height()

		if (!srcW || !srcH) return null

		const scale = Math.min(size / srcW, size / srcH)
		const dstW = Math.max(1, Math.round(srcW * scale))
		const dstH = Math.max(1, Math.round(srcH * scale))
		const dx = Math.floor((size - dstW) / 2)
		const dy = Math.floor((size - dstH) / 2)

		const scaled = source.scale_simple(dstW, dstH, GdkPixbuf.InterpType.HYPER)
			?? source.scale_simple(dstW, dstH, GdkPixbuf.InterpType.BILINEAR)
		if (!scaled) return null

		const square = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, size, size)
		if (!square) return null
		square.fill(0x00000000)
		scaled.copy_area(0, 0, dstW, dstH, square, dx, dy)

		return square
	})

	if (!result.ok) {
		console.error("textures.pixbufSquareContain: Failed to build square texture", result.err)
		return null
	}
	return result.value
}

function pixbufFromBytes(bytes: GLib.Bytes): GdkPixbuf.Pixbuf | null {
	const loader = GdkPixbuf.PixbufLoader.new()
	loader.write_bytes(bytes)
	loader.close()
	return loader.get_pixbuf()
}

export function isInlineImageData(uri: string): boolean {
	return uri.startsWith("data:image/") || uri.includes("iVBORw0KGgo") || uri.includes("/9j/")
}

function pixbufFromInlineImageData(uri: string): GdkPixbuf.Pixbuf | null {
	const result = attempt(() => {
		const base64 = uri.startsWith("data:") ? uri.split(",")[1] : uri
		const bytes = new GLib.Bytes(GLib.base64_decode(base64.replace(/\s/g, "")))
		return pixbufFromBytes(bytes)
	})
	if (!result.ok) {
		console.error("textures.inlineImage: Failed to decode base64 image", result.err)
		return null
	}
	return result.value
}

function loadHttpPixbufAsync(uri: string, onLoaded: (pixbuf: GdkPixbuf.Pixbuf | null) => void) {
	const started = attempt(() => {
		GLib.mkdir_with_parents(MPRIS_ART_CACHE_DIR, 0o755)
		const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, uri, -1)
		const cachePath = `${MPRIS_ART_CACHE_DIR}/${hash}`
		const cached = Gio.File.new_for_path(cachePath)
		if (cached.query_exists(null)) {
			const fresh = attempt(() => {
				const info = cached.query_info("time::modified", Gio.FileQueryInfoFlags.NONE, null)
				return Math.floor(Date.now() / 1000) - info.get_attribute_uint64("time::modified") <= HTTP_ART_CACHE_TTL_SECONDS
			})
			if (fresh.ok && fresh.value) {
				const decoded = attempt(() => GdkPixbuf.Pixbuf.new_from_file(cachePath))
				if (decoded.ok) {
					onLoaded(decoded.value)
					return
				}
			}
			attempt(() => cached.delete(null))
		}

		const process = Gio.Subprocess.new([
			"curl",
			"--fail",
			"--silent",
			"--location",
			"--connect-timeout", "5",
			"--max-time", "15",
			"--remove-on-error",
			"--output", cachePath,
			uri,
		], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE)
		process.wait_async(null, (_source, result) => {
			const loaded = attempt(() => {
				process.wait_finish(result)
				return process.get_successful() ? GdkPixbuf.Pixbuf.new_from_file(cachePath) : null
			})
			if (!loaded.ok || !loaded.value) attempt(() => cached.delete(null))
			onLoaded(loaded.ok ? loaded.value : null)
		})
	})
	if (!started.ok) {
		onLoaded(null)
	}
}

function loadLocalPixbufAsync(filePath: string, size: number, onLoaded: (texture: Gdk.Texture | null) => void) {
	const fallback = () => {
		const result = attempt(() => textureFromFileSquareContain(filePath, size))
		onLoaded(result.ok ? result.value : null)
	}

	const started = attempt(() => {
		const file = Gio.File.new_for_path(filePath)
		file.read_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
			const opened = attempt(() => (source as Gio.File).read_finish(result))
			if (!opened.ok) {
				fallback()
				return
			}
			GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(opened.value, size, size, true, null, (_pixbufSource, pixbufResult) => {
				const decoded = attempt(() => {
					const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(pixbufResult)
					const square = pixbuf ? pixbufSquareContain(pixbuf, size) : null
					return square ? Texture.new_for_pixbuf(square) : null
				})
				if (decoded.ok && decoded.value) onLoaded(decoded.value)
				else fallback()
			})
		})
	})
	if (!started.ok)
		fallback()
}

function textureFromUriSquareContain(uri: string, size: number): Gdk.Texture | null {
	if (!uri) return null
	const kind = classifyImageUri(uri)

	if (kind === "local") {
		return textureFromFileSquareContain(normalizeLocalImagePath(uri), size)
	}

	if (kind === "http") {
		return null
	}

	if (kind === "data") {
		const pixbuf = pixbufFromInlineImageData(uri)
		if (!pixbuf) return null
		const square = pixbufSquareContain(pixbuf, size)
		return square ? Texture.new_for_pixbuf(square) : null
	}

	return null
}

const asyncTextureCache = new Map<string, { texture: Accessor<Gdk.Texture | null>, createdAtUs: number }>()
const ASYNC_TEXTURE_CACHE_LIMIT = 64
const ASYNC_TEXTURE_RETRY_DELAYS_MS = [250, 1000, 3000]

function loadTextureAsync(
	key: string,
	texture: Accessor<Gdk.Texture | null>,
	setTexture: (texture: Gdk.Texture) => void,
	load: (done: (texture: Gdk.Texture | null) => void) => void,
	retry = 0,
) {
	load(loaded => {
		if (loaded) {
			setTexture(loaded)
			return
		}
		const delay = ASYNC_TEXTURE_RETRY_DELAYS_MS[retry]
		if (delay !== undefined) {
			timeout(delay, () => { loadTextureAsync(key, texture, setTexture, load, retry + 1) })
			return
		}

		if (asyncTextureCache.get(key)?.texture === texture)
			asyncTextureCache.delete(key)
	})
}

export function createSquareTextureAccessor(uri: string, size: number): Accessor<Gdk.Texture | null> {
	if (!uri) {
		const [empty] = createState<Gdk.Texture | null>(null)
		return empty
	}

	const kind = classifyImageUri(uri)
	const key = `${size}:${uri}`
	const cached = asyncTextureCache.get(key)
	const nowUs = GLib.get_monotonic_time()
	if (cached && (kind !== "http" || nowUs - cached.createdAtUs <= HTTP_ART_CACHE_TTL_SECONDS * 1_000_000))
		return cached.texture
	if (cached)
		asyncTextureCache.delete(key)

	const [texture, setTexture] = createState<Gdk.Texture | null>(null)
	asyncTextureCache.set(key, { texture, createdAtUs: nowUs })
	if (asyncTextureCache.size > ASYNC_TEXTURE_CACHE_LIMIT) {
		const oldest = asyncTextureCache.keys().next().value
		if (oldest) asyncTextureCache.delete(oldest)
	}

	if (kind === "http") {
		loadTextureAsync(key, texture, setTexture, done => {
			loadHttpPixbufAsync(uri, pixbuf => {
				if (!pixbuf) return done(null)
				const square = pixbufSquareContain(pixbuf, size)
				done(square ? Texture.new_for_pixbuf(square) : null)
			})
		})
		return texture
	}

	if (kind === "local") {
		const filePath = normalizeLocalImagePath(uri)
		loadTextureAsync(key, texture, setTexture, done => {
			loadLocalPixbufAsync(filePath, size, done)
		})
		return texture
	}

	idle(() => {
		const tex = textureFromUriSquareContain(uri, size)
		if (tex) setTexture(tex)
	})
	return texture
}

let hiddenDragTexture: Gdk.Texture | null = null

export function hiddenDragIcon(): Gdk.Texture {
	return hiddenDragTexture ??= Gdk.MemoryTexture.new(
		1,
		1,
		Gdk.MemoryFormat.R8G8B8A8,
		new Uint8Array([0, 0, 0, 0]),
		4,
	)
}
