// Loads and caches images from files, URLs, and embedded data and retries failed loads.

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
const SQUARE_TEXTURE_DISK_CACHE_DIR = env.paths.cache.thumbnails
// Memory caches are bounded and evict their oldest entries; async accessors use FIFO.
const squareContainTextureCache = new Map<string, { signature: string, texture: Gdk.Texture }>()
const fileSignatureCache = new Map<string, CachedSignature>()

type ImageUriKind = "local" | "http" | "data" | "unknown"

function classifyImageUri(uri: string): ImageUriKind {
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
		const file = Gio.File.new_for_uri(uri)
		file.load_bytes_async(null, (source, result) => {
			const loaded = attempt(() => {
				const [bytes] = (source as Gio.File).load_bytes_finish(result)
				return bytes ? pixbufFromBytes(bytes) : null
			})
			if (!loaded.ok) {
				console.error(`textures.loadHttpPixbufAsync: Failed to load ${uri}`, loaded.err)
				onLoaded(null)
				return
			}
			onLoaded(loaded.value)
		})
	})
	if (!started.ok) {
		console.error(`textures.loadHttpPixbufAsync: Failed to load ${uri}`, started.err)
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

const asyncTextureCache = new Map<string, Accessor<Gdk.Texture | null>>()
const ASYNC_TEXTURE_CACHE_LIMIT = 64
const ASYNC_TEXTURE_RETRY_DELAYS_MS = [250, 750, 1500]

function loadTextureWithRetry(
	key: string,
	texture: Accessor<Gdk.Texture | null>,
	setTexture: (texture: Gdk.Texture) => void,
	load: (done: (texture: Gdk.Texture | null) => void) => void,
	attempt = 0,
) {
	load(loaded => {
		if (loaded) {
			setTexture(loaded)
			return
		}

		const delay = ASYNC_TEXTURE_RETRY_DELAYS_MS[attempt]
		if (delay !== undefined) {
			timeout(delay, () => loadTextureWithRetry(key, texture, setTexture, load, attempt + 1))
			return
		}

		if (asyncTextureCache.get(key) === texture)
			asyncTextureCache.delete(key)
	})
}

export function createSquareTextureAccessor(uri: string, size: number): Accessor<Gdk.Texture | null> {
	if (!uri) {
		const [empty] = createState<Gdk.Texture | null>(null)
		return empty
	}

	const key = `${size}:${uri}`
	const cached = asyncTextureCache.get(key)
	if (cached) return cached

	const [texture, setTexture] = createState<Gdk.Texture | null>(null)
	asyncTextureCache.set(key, texture)
	if (asyncTextureCache.size > ASYNC_TEXTURE_CACHE_LIMIT) {
		const oldest = asyncTextureCache.keys().next().value
		if (oldest) asyncTextureCache.delete(oldest)
	}

	const kind = classifyImageUri(uri)
	if (kind === "http") {
		loadTextureWithRetry(key, texture, setTexture, done => {
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
		loadTextureWithRetry(key, texture, setTexture, done => {
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
