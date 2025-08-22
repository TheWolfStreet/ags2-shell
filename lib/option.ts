import { env } from "$lib/env"
import { Accessor, createState, Setter } from "ags"
import { readFile, writeFile } from "ags/file"
import { ensurePath } from "./utils"

namespace store {
	export const path = `${env.paths.cfg}/options.json`

	export function modify(updater: (data: Record<string, any>) => void) {
		try {
			ensurePath(store.path)
			const raw = readFile(path) || "{}"
			const data = JSON.parse(raw)
			updater(data)
			writeFile(path, JSON.stringify(data, null, 2))
		} catch {
			// ignore
		}
	}

	export function read() {
		ensurePath(store.path)
		const raw = readFile(path) || "{}"
		return JSON.parse(raw)
	}
}

export class Opt<T> extends Accessor<T> {
	#setter: Setter<T>
	#default: T
	id = ""

	constructor(initial: T) {
		const [acc, set] = createState(initial)
		super(() => acc.get(), (cb) => acc.subscribe(cb))
		this.#setter = set
		this.#default = initial
	}

	[Symbol.toPrimitive]() {
		console.warn("Opt implicitly converted to a primitive value.", new Error().stack)
		return this.toString()
	}

	set(v: T) {
		this.#setter(v)
		// TODO: persist
	}

	reset() {
		this.#setter(this.#default)
		// TODO: delete from store
	}

	getDefault() {
		return this.#default
	}

	toString(): string {
		return `${this.get()}`
	}

	toJSON() {
		return `opt:${this.get()}`
	}
}

function isStructured(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type Options<T> =
	T extends Record<string, unknown> ? { [K in keyof T]: Options<T[K]> } :
	Opt<T>

export function mkOptions<T>(node: T, path = ""): Options<T> {
	if (isStructured(node)) {
		const newNode = {} as any;
		for (const key in node) {
			if (Object.prototype.hasOwnProperty.call(node, key)) {
				const subPath = path ? `${path}.${key}` : key;
				newNode[key] = mkOptions((node as any)[key], subPath);
			}
		}
		return newNode;
	}

	const opt = new Opt(node);
	opt.id = path;

	return opt as any;
}

export function setHandler(
	opts: Options<any>,
	deps: string[],
	callback: () => void,
) {
	if (opts instanceof Opt) {
		if (deps.some(d => opts.id.startsWith(d))) opts.subscribe(callback)
		return
	}

	for (const key in opts) {
		if (Object.prototype.hasOwnProperty.call(opts, key)) {
			const next = opts[key]
			setHandler(next, deps, callback)
		}
	}
}
