import GObject, { register } from "ags/gobject"
import { timeout, Timer } from "ags/time"
import { readFile, writeFileAsync } from "ags/file"

import env from "$lib/env"
import { ensurePath } from "$lib/utils"

type IconPosition = {
	path: string
	x: number
	y: number
	monitor: string
}

type DesktopState = {
	positions: IconPosition[]
	version: number
}

const cacheFile = `${env.paths.cache}/desktop-state.json`

@register()
export default class Desktop extends GObject.Object {
	declare static $gtype: GObject.GType<Desktop>
	static instance: Desktop

	static get_default() {
		return this.instance ??= new Desktop()
	}

	#positions: Map<string, IconPosition[]>
	#saveDebounce: Timer | null

	constructor() {
		super()

		ensurePath(cacheFile)
		this.#saveDebounce = null

		const state = JSON.parse(readFile(cacheFile) || '{"positions":[],"version":1}') as DesktopState

		this.#positions = new Map()
		state.positions.forEach(pos => {
			if (!this.#positions.has(pos.monitor)) {
				this.#positions.set(pos.monitor, [])
			}
			this.#positions.get(pos.monitor)!.push(pos)
		})
	}

	readonly getPositions = (monitorId: string): IconPosition[] => {
		return this.#positions.get(monitorId) || []
	}

	readonly setPosition = (monitorId: string, path: string, x: number, y: number) => {
		if (!this.#positions.has(monitorId)) {
			this.#positions.set(monitorId, [])
		}

		const positions = this.#positions.get(monitorId)!
		const existing = positions.findIndex(p => p.path === path)

		if (existing >= 0) {
			positions[existing] = { path, x, y, monitor: monitorId }
		} else {
			positions.push({ path, x, y, monitor: monitorId })
		}

		this.#scheduleSave()
	}

	readonly removePosition = (monitorId: string, path: string) => {
		const positions = this.#positions.get(monitorId)
		if (!positions) return

		const filtered = positions.filter(p => p.path !== path)
		this.#positions.set(monitorId, filtered)
		this.#scheduleSave()
	}

	readonly clearMonitor = (monitorId: string) => {
		this.#positions.delete(monitorId)
		this.#scheduleSave()
	}

	readonly #scheduleSave = () => {
		if (this.#saveDebounce) this.#saveDebounce.cancel()

		this.#saveDebounce = timeout(1000, async () => {
			try {
				ensurePath(cacheFile)
				const state: DesktopState = {
					positions: Array.from(this.#positions.values()).flat(),
					version: 1
				}
				await writeFileAsync(cacheFile, JSON.stringify(state, null, 2))
			} catch (e) {
				console.error("failed to save desktop state", e)
			}
			this.#saveDebounce = null
		})
	}
}
