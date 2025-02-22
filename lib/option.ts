import { readFile, writeFile, monitorFile, Variable, GLib } from "astal"
import { env } from "./environment"

interface OptProps {
	persistent?: boolean
}

export class Opt<T = unknown> extends Variable<T> {

	constructor(initial: T, { persistent = false }: OptProps = {}) {
		super(initial)
		this.initial = initial
		this.persistent = persistent
	}

	initial: T
	id = ""
	persistent: boolean

	toString = () => `${this.get()}`
	toJSON() { return `opt:${this.get()}` }

	get = (): T => {
		return super.get()
	}

	init(cache_file: string) {
		const cachedVal = JSON.parse(readFile(cache_file) || "{}")[this.id]
		if (cachedVal !== undefined)
			this.set(cachedVal)

		this.subscribe(() => {
			const cache = JSON.parse(readFile(cache_file) || "{}")
			cache[this.id] = this.get()

			writeFile(cache_file, JSON.stringify(cache, null, 2))
		})
	}

	reset() {
		if (this.persistent)
			return

		if (JSON.stringify(this.get()) !== JSON.stringify(this.initial)) {
			this.set(this.initial)
			return this.id
		}
	}
}

export const opt = <T>(initial: T, opts?: OptProps) => new Opt(initial, opts)

function getOptions(object: Record<string, any>, path = ""): Opt[] {
	return Object.keys(object).flatMap(key => {
		const obj: Opt = object[key]
		const id = path ? path + "." + key : key

		if (obj instanceof Variable) {
			obj.id = id
			return obj
		}

		if (typeof obj === "object") {
			return getOptions(obj, id)
		}

		return []
	})
}

export function mkOptions<T extends object>(object: T) {
	const cacheFile = `${env.paths.cache}/options.json`
	if (!GLib.file_test(cacheFile, GLib.FileTest.EXISTS)) {
		writeFile(cacheFile, "")
	}
	for (const opt of getOptions(object))
		opt.init(cacheFile)

	const values = getOptions(object).reduce((obj, { id, get }) => {
		return { [id]: get(), ...obj }
	}, {})


	const cfgFile = `${env.paths.tmp}/config.json`
	writeFile(cfgFile, JSON.stringify(values, null, 2))

	monitorFile(cfgFile, () => {
		const cache = JSON.parse(readFile(cfgFile) || "{}")
		for (const opt of getOptions(object)) {
			if (JSON.stringify(cache[opt.id]) !== JSON.stringify(opt.get()))
				opt.set(cache[opt.id])
		}
	})

	function sleep(ms = 0) {
		return new Promise(r => setTimeout(r, ms))
	}

	async function reset(
		[opt, ...list] = getOptions(object),
		id = opt?.reset(),
	): Promise<Array<string>> {
		if (!opt)
			return sleep().then(() => [])

		return id
			? [id, ...(await sleep(50).then(() => reset(list)))]
			: await sleep().then(() => reset(list))
	}

	return Object.assign(object, {
		configFile: cfgFile,
		array: () => getOptions(object),
		async reset() {
			return (await reset()).join("\n")
		},
		handler(deps: string[], callback: () => void) {
			for (const opt of getOptions(object)) {
				if (deps.some(i => opt.id.startsWith(i)))
					opt.subscribe(callback)
			}
		},
	})
}
