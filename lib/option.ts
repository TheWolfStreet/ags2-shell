import { Accessor, createState, Setter } from "ags"
import { readFile, writeFileAsync } from "ags/file"

import env from "$lib/env"
import { ensurePath } from "$lib/files"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/timing"

namespace Store {
	export const path = `${env.paths.cache.base}/options.json`

	let cache: Record<string, unknown> | null = null

	function ensureLoaded() {
		if (cache !== null) return
		const result = attempt(() => {
			ensurePath(path)
			const raw = readFile(path) || "{}"
			return JSON.parse(raw) as Record<string, unknown>
		})
		cache = result.ok ? result.value : {}
	}

	const save = debounce(3000, async () => {
		const result = await attemptAsync(async () => {
			ensurePath(path)
			await writeFileAsync(path, JSON.stringify(cache, null, 2))
		})
		if (!result.ok)
			console.error("option.store.save: Failed to save options store", result.err)
	})

	export function get(pathStr: string): unknown {
		ensureLoaded()
		const parts = splitPath(pathStr)
		let node: unknown = cache
		for (const part of parts) {
			if (!isStructured(node))
				return undefined
			node = node[part]
		}
		return node
	}

	const pathCache = new Map<string, string[]>()

	function splitPath(pathStr: string): string[] {
		if (!pathCache.has(pathStr)) {
			pathCache.set(pathStr, pathStr.split("."))
		}
		return pathCache.get(pathStr)!
	}

	export function set(pathStr: string, value: unknown): void {
		ensureLoaded()
		const parts = splitPath(pathStr)
		const root = cache
		if (!root)
			return

		let node = root
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i]
			let next = node[part]
			if (!isStructured(next)) {
				next = {}
				node[part] = next
			}
			node = next
		}
		node[parts[parts.length - 1]] = value
		save.call()
	}

	export function del(pathStr: string): void {
		ensureLoaded()
		const parts = splitPath(pathStr)
		const root = cache
		if (!root)
			return

		let node = root
		for (let i = 0; i < parts.length - 1; i++) {
			const next = node[parts[i]]
			if (!isStructured(next))
				return
			node = next
		}
		delete node[parts[parts.length - 1]]
		save.call()
	}
}

export class Opt<T> extends Accessor<T> {
	#setter: Setter<T>
	#default: T
	readonly id: string

	constructor(initial: T, id = "") {
		const [acc, set] = createState(initial)
		super(() => acc.peek(), (cb) => acc.subscribe(cb))
		this.#setter = set
		this.#default = initial
		this.id = id
	}

	[Symbol.toPrimitive]() {
		console.warn("Opt implicitly converted to a primitive value.", new Error().stack)
		return this.toString()
	}

	set(v: T) {
		if (Object.is(this.peek(), v))
			return

		this.#setter(v)
		if (v === this.#default) {
			Store.del(this.id)
		} else {
			Store.set(this.id, v)
		}
	}

	reset() {
		this.#setter(this.#default)
		Store.del(this.id)
	}

	getDefault() {
		return this.#default
	}

	toString(): string {
		return `${this.peek()}`
	}

	toJSON() {
		return `opt:${this.peek()}`
	}
}

function isStructured(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

type WidenLiterals<T> = T extends boolean ? boolean : T extends string ? string : T extends number ? number : T

export type Options<T> =
	T extends Record<string, unknown> ? { [K in keyof T]: Options<T[K]> } :
	Opt<WidenLiterals<T>>

export function mkOptions<T>(node: T, path?: string): Options<T>
export function mkOptions(node: unknown, path = ""): unknown {
	if (isStructured(node)) {
		const newNode: Record<string, unknown> = {}

		for (const key in node) {
			if (Object.prototype.hasOwnProperty.call(node, key)) {
				const subPath = path ? `${path}.${key}` : key
				newNode[key] = mkOptions(node[key], subPath)
			}
		}
		return newNode
	}

	const storedVal = path ? Store.get(path) : undefined
	const opt = new Opt(node, path)

	if (storedVal !== undefined)
		opt.set(storedVal)

	return opt
}

export function setHandler(
	opts: Opt<any> | Record<string, any>,
	deps: string[],
	callback: () => void,
): void {
	if (opts instanceof Opt) {
		if (deps.some(d => opts.id.startsWith(d))) opts.subscribe(callback)
		return
	}

	for (const key in opts) {
		if (Object.prototype.hasOwnProperty.call(opts, key)) {
			setHandler(opts[key], deps, callback)
		}
	}
}
