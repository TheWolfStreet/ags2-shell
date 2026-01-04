import { Accessor, createState, Setter } from "ags"
import { Timer, timeout } from "ags/time"
import { readFile, writeFileAsync } from "ags/file"

import { ensurePath } from "$lib/utils"
import env from "$lib/env"

namespace Store {
	export const path = `${env.paths.cache}/options.json`

	let saveDebounce: Timer | null = null
	let cache: Record<string, unknown> | null = null

	function ensureLoaded() {
		if (cache !== null) return
		try {
			ensurePath(path)
			const raw = readFile(path) || "{}"
			cache = JSON.parse(raw)
		} catch {
			cache = {}
		}
	}

	function scheduleSave() {
		if (saveDebounce) return
		saveDebounce = timeout(3000, async () => {
			try {
				ensurePath(path)
				await writeFileAsync(path, JSON.stringify(cache, null, 2))
			} catch (e) {
				console.error("Failed to save store:", e)
			} finally {
				saveDebounce = null
			}
		})
	}

	export function get(pathStr: string): unknown {
		ensureLoaded()
		const parts = pathStr.split(".")
		let node: Record<string, unknown> | null = cache
		for (const part of parts) {
			if (!node || typeof node !== "object") return undefined
			node = node[part] as Record<string, unknown> | null
		}
		return node
	}

	export function set(pathStr: string, value: unknown): void {
		ensureLoaded()
		const parts = pathStr.split(".")
		let node = cache as Record<string, unknown>
		for (let i = 0; i < parts.length - 1; i++) {
			if (!(parts[i] in node)) node[parts[i]] = {}
			node = node[parts[i]] as Record<string, unknown>
		}
		node[parts[parts.length - 1]] = value
		scheduleSave()
	}

	export function del(pathStr: string): void {
		ensureLoaded()
		const parts = pathStr.split(".")
		let node = cache as Record<string, unknown>
		for (let i = 0; i < parts.length - 1; i++) {
			if (!(parts[i] in node)) return
			node = node[parts[i]] as Record<string, unknown>
		}
		delete node[parts[parts.length - 1]]
		scheduleSave()
	}
}

export class Opt<T> extends Accessor<T> {
	#setter: Setter<T>
	#default: T
	id = ""

	constructor(initial: T) {
		const [acc, set] = createState(initial)
		super(() => acc.peek(), (cb) => acc.subscribe(cb))
		this.#setter = set
		this.#default = initial
	}

	[Symbol.toPrimitive]() {
		console.warn("Opt implicitly converted to a primitive value.", new Error().stack)
		return this.toString()
	}

	set(v: T) {
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
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type WidenLiterals<T> = T extends boolean ? boolean : T extends string ? string : T extends number ? number : T

export type Options<T> =
	T extends Record<string, unknown> ? { [K in keyof T]: Options<T[K]> } :
	Opt<WidenLiterals<T>>

export function mkOptions<T>(node: T, path = ""): Options<T> {
	if (isStructured(node)) {
		const newNode: Record<string, unknown> = {}

		for (const key in node) {
			if (Object.prototype.hasOwnProperty.call(node, key)) {
				const subPath = path ? `${path}.${key}` : key
				newNode[key] = mkOptions(node[key], subPath)
			}
		}
		return newNode as Options<T>
	}

	const defaultVal = node
	const storedVal = path ? Store.get(path) : undefined
	const initialVal = storedVal !== undefined ? (storedVal as T) : defaultVal

	const opt = new Opt(defaultVal)
	opt.id = path

	if (storedVal !== undefined) {
		opt.set(initialVal)
	}

	return opt as Options<T>
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
