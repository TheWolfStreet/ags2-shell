// Loads, saves, and lists the settings users can change.

import { Accessor, createState, Setter } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import icons from "$lib/icons"
import env from "$lib/env"
import { ensureFile } from "$lib/files"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/time"

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
			console.error(
				"option.store.load: Failed to load options store",
				result.err,
			)
		else if (!isStructured(result.value))
			console.error(
				"option.store.load: Options store does not contain an object",
			)
		cache = result.ok && isStructured(result.value) ? result.value : {}
	}

	const save = debounce(3000, async () => {
		const result = await attemptAsync(async () => {
			ensureFile(path)
			await writeFileAsync(path, JSON.stringify(cache, null, 2))
		})
		if (!result.ok)
			console.error(
				"option.store.save: Failed to save options store",
				result.err,
			)
	})

	export function get(pathStr: string): unknown {
		ensureLoaded()
		const parts = splitPath(pathStr)
		let node: unknown = cache
		for (const part of parts) {
			if (!isStructured(node)) return undefined
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
		if (!root) return

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
		if (!root) return

		let node = root
		for (let i = 0; i < parts.length - 1; i++) {
			const next = node[parts[i]]
			if (!isStructured(next)) return
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
		super(
			() => acc.peek(),
			(cb) => acc.subscribe(cb),
		)
		this.#setter = set
		this.#default = initial
		this.id = id
	}

	[Symbol.toPrimitive]() {
		console.warn(
			"Opt implicitly converted to a primitive value.",
			new Error().stack,
		)
		return this.toString()
	}

	set(v: T) {
		if (Object.is(this.peek(), v)) return

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

type WidenLiterals<T> = T extends boolean
	? boolean
	: T extends string
		? string
		: T extends number
			? number
			: T

function isPrimitive(
	value: unknown,
): value is string | number | boolean | null {
	return (
		value === null || ["string", "number", "boolean"].includes(typeof value)
	)
}

function isCompatibleLeaf(stored: unknown, defaultValue: unknown): boolean {
	if (Array.isArray(defaultValue)) {
		if (!Array.isArray(stored) || !stored.every(isPrimitive)) return false

		const elementTypes = new Set(
			defaultValue
				.filter(isPrimitive)
				.map((value) => (value === null ? "null" : typeof value)),
		)
		return (
			elementTypes.size === 0 ||
			stored.every((value) =>
				elementTypes.has(value === null ? "null" : typeof value),
			)
		)
	}

	if (!isPrimitive(defaultValue) || !isPrimitive(stored)) return false

	return defaultValue === null
		? stored === null
		: typeof stored === typeof defaultValue
}

export type OptionConstraints = Readonly<
	Record<string, readonly (string | number)[]>
>

export type Options<T> =
	T extends Record<string, unknown>
		? { [K in keyof T]: Options<T[K]> }
		: Opt<WidenLiterals<T>>

export function mkOptions<T>(
	node: T,
	constraints: OptionConstraints = {},
): Options<T> {
	return buildOptions(node, "", constraints) as Options<T>
}

function buildOptions(
	node: unknown,
	path: string,
	constraints: OptionConstraints,
): unknown {
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
		const isAllowed =
			!allowedValues ||
			allowedValues.some((value) => Object.is(value, storedVal))
		if (isCompatibleLeaf(storedVal, node) && isAllowed) opt.set(storedVal)
		else Store.del(path)
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
		if (
			prefixes.some(
				(prefix) => opts.id === prefix || opts.id.startsWith(`${prefix}.`),
			)
		)
			disposers.push(opts.subscribe(callback))
	} else if (isStructured(opts)) {
		for (const key in opts) {
			if (Object.prototype.hasOwnProperty.call(opts, key))
				disposers.push(subscribeOptions(opts[key], prefixes, callback))
		}
	}

	return () => disposers.forEach((dispose) => dispose())
}

export const optionValues = {
	themeScheme: ["dark", "light"],
	barPosition: ["top-center", "bottom-center"],
	taskbarLocation: ["bar", "dock"],
	dockMode: ["static", "autohide"],
	dockPosition: ["bottom-center", "center-left"],
	desktopIconSize: ["small", "medium", "large", "extralarge"],
	launcherPosition: ["top-center", "bottom-center"],
	favoritesLocation: ["disabled", "dock", "launcher", "both"],
	popupPosition: [
		"top-left",
		"top-center",
		"top-right",
		"bottom-left",
		"bottom-center",
		"bottom-right",
	],
	dateMenuPosition: ["center", "top-center", "bottom-center"],
	powerMenuLayout: ["box", "line"],
	osdPosition: ["center", "bottom-center"],
} as const

const constraints = {
	"theme.scheme": optionValues.themeScheme,
	"bar.position": optionValues.barPosition,
	"taskbar.location": optionValues.taskbarLocation,
	"dock.mode": optionValues.dockMode,
	"dock.position": optionValues.dockPosition,
	"desktop.iconSize": optionValues.desktopIconSize,
	"launcher.position": optionValues.launcherPosition,
	"favorites.location": optionValues.favoritesLocation,
	"quicksettings.position": optionValues.popupPosition,
	"datemenu.position": optionValues.dateMenuPosition,
	"powermenu.layout": optionValues.powerMenuLayout,
	"osd.position": optionValues.osdPosition,
	"notifications.position": optionValues.popupPosition,
} as const

let launcherIcon = icons.ui.search
if (
	env.distro.logo &&
	new Gtk.IconTheme({ themeName: app.iconTheme }).has_icon(env.distro.logo)
)
	launcherIcon = env.distro.logo

const options = mkOptions(
	{
		autotheme: false,
		scale: 100,
		font: "SFProDisplay Nerd Font 11",
		transition: {
			duration: 200,
		},

		theme: {
			scheme: "dark",
			dark: {
				bg: "#171717",
				fg: "#eeeeee",
				primary: {
					bg: "#51a4e7",
					fg: "#141414",
				},
				error: {
					bg: "#e55f86",
				},
				widget: "#eeeeee",
				border: "#9a9996",
			},
			light: {
				bg: "#fffffa",
				fg: "#080808",
				primary: {
					bg: "#426ede",
					fg: "#eeeeee",
				},
				error: {
					bg: "#b13558",
				},
				widget: "#080808",
				border: "#080808",
			},

			opacity: 30,
			widget: {
				opacity: 94,
			},
			border: {
				width: 1,
				opacity: 86,
			},
			shadows: true,
			blur: true,
			neumorphic: true,

			padding: 8,
			spacing: 6,
			roundness: 12,
		},

		bar: {
			position: "top-center",
			transparent: false,
			corners: 50,

			launcher: {
				icon: launcherIcon,
			},
			workspaces: {
				count: 7,
			},
			taskbar: {
				exclusive: false,
			},
			date: {
				format: "%a %b %-d %H:%M",
			},
			media: {
				preferred: "spotify",
			},
			systray: {
				ignore: ["KDE Connect Indicator", "spotify-client", "spotify"],
			},
		},

		taskbar: {
			location: "dock",
		},

		dock: {
			mode: "static",
			position: "bottom-center",
			scale: 100,
			trash: true,
		},

		desktop: {
			enabled: true,
			iconSize: "medium",
		},

		launcher: {
			position: "top-center",
			margin: 40,
			scale: 100,
			apps: {
				max: 6,
			},
		},

		favorites: {
			location: "both",
		},

		overview: {
			scale: 100,
			workspaces: 7,
		},

		quicksettings: {
			position: "top-right",
			width: 380,
		},

		datemenu: {
			position: "center",
		},

		powermenu: {
			layout: "line",
			labels: true,
			sleep: "systemctl suspend",
			reboot: "systemctl reboot",
			logout: "hyprctl dispatch exit",
			shutdown: "shutdown now",
		},

		osd: {
			position: "bottom-center",
			dismiss: 1200,
		},

		notifications: {
			position: "top-right",
			blacklist: ["Spotify", "com.spotify.Client"],
			dismiss: 3500,
		},

		colorpicker: {
			maxColors: 10,
		},

		hyprland: {
			gaps: 2.4,
			inactiveBorder: "#282828",
		},

		asus: {
			ac_hz: 144,
			bat_hz: 60,
		},
	},
	constraints,
)

export default options
