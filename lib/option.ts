// Loads and saves settings and watches groups of settings for changes.

import { Accessor, createState, Setter } from "ags"
import { readFile, writeFileAsync } from "ags/file"

import env from "$lib/env"
import { ensureFile } from "$lib/files"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/timing"

namespace Store {
	export const path = `${env.paths.cache.base}/options.json`

	let cache: Record<string, unknown> | null = null

	function ensureLoaded() {
		if (cache !== null) return
		const result = attempt(() => {
			ensureFile(path)
			const raw = readFile(path) || "{}"
			return JSON.parse(raw) as Record<string, unknown>
		})
		if (!result.ok)
			console.error("option.store.load: Failed to load options store", result.err)
		else if (!isStructured(result.value))
			console.error("option.store.load: Options store does not contain an object")
		cache = result.ok && isStructured(result.value) ? result.value : {}
	}

	const save = debounce(3000, async () => {
		const result = await attemptAsync(async () => {
			ensureFile(path)
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

		let node: Record<string, unknown> = root
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i]
			const next = node[part]
			if (isStructured(next)) {
				node = next
				continue
			}

			const child: Record<string, unknown> = {}
			node[part] = child
			node = child
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
}

function isStructured(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

type WidenLiterals<T> = T extends boolean ? boolean : T extends string ? string : T extends number ? number : T

function isPrimitive(value: unknown): value is string | number | boolean | null {
	return value === null || ["string", "number", "boolean"].includes(typeof value)
}

function isCompatibleLeaf(stored: unknown, defaultValue: unknown): boolean {
	if (Array.isArray(defaultValue)) {
		if (!Array.isArray(stored) || !stored.every(isPrimitive))
			return false

		const elementTypes = new Set(defaultValue.filter(isPrimitive).map(value => value === null ? "null" : typeof value))
		return elementTypes.size === 0 || stored.every(value => elementTypes.has(value === null ? "null" : typeof value))
	}

	if (!isPrimitive(defaultValue) || !isPrimitive(stored))
		return false

	return defaultValue === null ? stored === null : typeof stored === typeof defaultValue
}

export type OptionConstraints = Readonly<Record<string, readonly (string | number)[]>>

export type Options<T> =
	T extends Record<string, unknown> ? { [K in keyof T]: Options<T[K]> } :
	Opt<WidenLiterals<T>>

export function mkOptions<T>(node: T, constraints: OptionConstraints = {}): Options<T> {
	return buildOptions(node, "", constraints) as Options<T>
}

function buildOptions(node: unknown, path: string, constraints: OptionConstraints): unknown {
	if (isStructured(node)) {
		const newNode: Record<string, unknown> = {}

		for (const key in node) {
			if (Object.prototype.hasOwnProperty.call(node, key)) {
				const subPath = path ? `${path}.${key}` : key
				newNode[key] = buildOptions(node[key], subPath, constraints)
			}
		}
		return newNode
	}

	const storedVal = path ? Store.get(path) : undefined
	const opt = new Opt(node, path)

	if (storedVal !== undefined) {
		const allowedValues = constraints[path]
		const isAllowed = !allowedValues || allowedValues.some(value => Object.is(value, storedVal))
		if (isCompatibleLeaf(storedVal, node) && isAllowed)
			opt.set(storedVal)
		else
			Store.del(path)
	}

	return opt
}

export function subscribeOptions(
	opts: unknown,
	prefixes: readonly string[],
	callback: () => void,
): () => void {
	const disposers: Array<() => void> = []

	if (opts instanceof Opt) {
		if (prefixes.some(prefix => opts.id === prefix || opts.id.startsWith(`${prefix}.`)))
			disposers.push(opts.subscribe(callback))
	} else if (isStructured(opts)) {
		for (const key in opts) {
			if (Object.prototype.hasOwnProperty.call(opts, key))
				disposers.push(subscribeOptions(opts[key], prefixes, callback))
		}
	}

	return () => disposers.forEach(dispose => dispose())
}
