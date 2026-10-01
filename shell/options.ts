import { Accessor, createState, type Setter } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { Gtk } from "ags/gtk4"
import app from "$lib/app"

import icons from "$lib/icons"
import env from "$lib/env"
import { ensure_file } from "$lib/files"
import { attempt, attempt_async, err, log_error, ok, type Result } from "$lib/result"
import { debounce } from "$lib/time"

namespace Store {
	const path = `${env.paths.cache.base}/options.json`

	let cache: Record<string, unknown> | null = null

	function ensure_loaded() {
		if (cache !== null) return
		const ready = ensure_file(path)
		const result = ready.ok ? attempt(() => {
			const raw = readFile(path) || "{}"
			return JSON.parse(raw) as Record<string, unknown>
		}) : ready
		if (
			log_error(result, "option.store.load: Failed to load options store") &&
			!is_structured(result.value)
		)
			console.error(
				"option.store.load: Options store does not contain an object",
			)
		cache = result.ok && is_structured(result.value) ? result.value : {}
	}

	let last_save: Promise<Result<void>> = Promise.resolve(ok(undefined))
	let revision = 0
	let saved_revision = 0

	function write(): Promise<Result<void>> {
		last_save = last_save.then(async () => {
			if (revision === saved_revision) return ok(undefined)
			const writing_revision = revision
			const ready = ensure_file(path)
			const result = ready.ok ? await attempt_async(async () => {
				await writeFileAsync(path, JSON.stringify(cache, null, 2))
			}) : ready
			if (result.ok) saved_revision = writing_revision
			log_error(result, "option.store.save: Failed to save options store")
			return result
		})
		return last_save
	}

	const save = debounce(3000, () => { void write() })

	export function flush(): Promise<Result<void>> {
		if (save.pending) {
			save.cancel()
			return write()
		}
		if (revision !== saved_revision) return write()
		return last_save
	}

	export function get(path_str: string): unknown {
		ensure_loaded()
		const parts = split_path(path_str)
		let node: unknown = cache
		for (const part of parts) {
			if (!is_structured(node)) return undefined
			node = node[part]
		}
		return node
	}

	function split_path(path_str: string): string[] {
		return path_str.split(".")
	}

	export function set(path_str: string, value: unknown): void {
		ensure_loaded()
		const parts = split_path(path_str)
		const root = cache
		if (!root) return

		let node: Record<string, unknown> = root
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i]
			const next = node[part]
			if (is_structured(next)) {
				node = next
				continue
			}

			const child: Record<string, unknown> = {}
			node[part] = child
			node = child
		}
		node[parts[parts.length - 1]] = value
		revision++
		save.call()
	}

	export function del(path_str: string): void {
		ensure_loaded()
		const parts = split_path(path_str)
		const root = cache
		if (!root) return

		let node = root
		for (let i = 0; i < parts.length - 1; i++) {
			const next = node[parts[i]]
			if (!is_structured(next)) return
			node = next
		}
		delete node[parts[parts.length - 1]]
		revision++
		save.call()
	}
}

function same_leaf(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
	return Object.is(a, b)
}

function snapshot_leaf<T>(value: T): T {
	return Array.isArray(value) ? Object.freeze([...value]) as T : value
}

export class Opt<T> extends Accessor<T> {
	#setter: Setter<T>
	#default: T
	#valid: (value: unknown) => boolean
	readonly id: string

	constructor(initial: T, id: string, valid: (value: unknown) => boolean, current: T = initial) {
		const default_value = snapshot_leaf(initial)
		const [acc, set] = createState(same_leaf(current, default_value) ? default_value : snapshot_leaf(current))
		super(
			() => acc.peek(),
			(cb) => acc.subscribe(cb),
		)
		this.#setter = set
		this.#default = default_value
		this.#valid = valid
		this.id = id
	}

	[Symbol.toPrimitive]() {
		console.warn(
			"Opt implicitly converted to a primitive value.",
			new Error().stack,
		)
		return this.toString()
	}

	set(v: T): Result<void> {
		if (!this.#valid(v)) {
			const result = err(new Error(`Invalid value for option ${this.id}`))
			log_error(result, "option.set")
			return result
		}
		if (same_leaf(this.peek(), v)) return ok(undefined)

		const value = same_leaf(v, this.#default) ? this.#default : snapshot_leaf(v)
		if (value === this.#default) {
			Store.del(this.id)
		} else {
			Store.set(this.id, value)
		}
		this.#setter(value)
		return ok(undefined)
	}

	reset() {
		return this.set(this.#default)
	}

	get_default() {
		return this.#default
	}

	toString(): string {
		return `${this.peek()}`
	}
}

function is_structured(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

type WidenLiterals<T> = T extends boolean
	? boolean
	: T extends string
		? string
		: T extends number
			? number
			: T

type OptionRule = readonly (string | number)[] | { min: number, max: number, integer?: boolean }
type OptionConstraints = Readonly<Record<string, OptionRule>>

function valid_leaf(value: unknown, initial: unknown, path: string, constraints: OptionConstraints): boolean {
	const rule = constraints[path]
	if (Array.isArray(rule))
		return rule.some((allowed) => Object.is(allowed, value))

	if (Array.isArray(initial)) {
		return Array.isArray(value) && value.length <= 128 && value.every((item) =>
			typeof item === typeof initial[0] && typeof item === "string" && item.length <= 256)
	}
	if (typeof initial === "boolean") return typeof value === "boolean"
	if (typeof initial === "string") {
		if (typeof value !== "string" || value.length > 4096) return false
		if (initial.startsWith("#")) return /^#[0-9a-f]{6}$/i.test(value)
		if (path === "font") return /^[^\n\r\\";{}]+\s+(?:[1-9]|[1-6][0-9]|7[0-2])(?:\.\d+)?$/.test(value)
		return !/[\x00-\x1f]/.test(value)
	}
	if (typeof initial === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) return false
		if (rule && "min" in rule)
			return value >= rule.min && value <= rule.max && (!rule.integer || Number.isInteger(value))
		return value >= 0 && value <= 1000 && Number.isInteger(value)
	}
	return false
}

export type Options<T> =
	T extends Record<string, unknown>
		? { [K in keyof T]: Options<T[K]> }
		: Opt<WidenLiterals<T>>

export function mk_options<T>(
	node: T,
	constraints: OptionConstraints = {},
): Options<T> {
	return build_options(node, "", constraints) as Options<T>
}

function build_options(
	node: unknown,
	path: string,
	constraints: OptionConstraints,
): unknown {
	if (is_structured(node)) {
		const new_node: Record<string, unknown> = {}

		for (const key in node) {
			if (Object.prototype.hasOwnProperty.call(node, key)) {
				const sub_path = path ? `${path}.${key}` : key
				new_node[key] = build_options(node[key], sub_path, constraints)
			}
		}
		return new_node
	}

	const stored_val = path ? Store.get(path) : undefined
	const valid = (value: unknown) => valid_leaf(value, node, path, constraints)

	if (stored_val !== undefined) {
		if (valid(stored_val)) return new Opt(node, path, valid, stored_val)
		Store.del(path)
	}

	return new Opt(node, path, valid)
}

export function flush_options(): Promise<Result<void>> {
	return Store.flush()
}

export function subscribe_options(
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
	} else if (is_structured(opts)) {
		for (const key in opts) {
			if (Object.prototype.hasOwnProperty.call(opts, key))
				disposers.push(subscribe_options(opts[key], prefixes, callback))
		}
	}

	return () => disposers.forEach((dispose) => dispose())
}

export const option_values = {
	theme_scheme: ["dark", "light"],
	bar_position: ["top-center", "bottom-center"],
	taskbar_location: ["bar", "dock"],
	dock_mode: ["static", "autohide"],
	dock_position: ["bottom-center", "center-left"],
	desktop_icon_size: ["small", "medium", "large", "extralarge"],
	launcher_position: ["top-center", "bottom-center"],
	favorites_location: ["disabled", "dock", "launcher", "both"],
	popup_position: [
		"top-left",
		"top-center",
		"top-right",
		"bottom-left",
		"bottom-center",
		"bottom-right",
	],
	date_menu_position: ["center", "top-center", "bottom-center"],
	power_menu_layout: ["box", "line"],
	osd_position: ["center", "bottom-center"],
} as const

const constraints = {
	"scale": { min: 50, max: 200, integer: true },
	"transition.duration": { min: 0, max: 2000, integer: true },
	"theme.scheme": option_values.theme_scheme,
	"theme.opacity": { min: 0, max: 70, integer: true },
	"theme.widget.opacity": { min: 0, max: 100, integer: true },
	"theme.border.width": { min: 0, max: 100, integer: true },
	"theme.border.opacity": { min: 0, max: 100, integer: true },
	"theme.padding": { min: 0, max: 50, integer: true },
	"theme.spacing": { min: 0, max: 50, integer: true },
	"theme.roundness": { min: 0, max: 50, integer: true },
	"bar.position": option_values.bar_position,
	"bar.corners": { min: 0, max: 100, integer: true },
	"bar.workspaces.count": { min: 0, max: 16, integer: true },
	"taskbar.location": option_values.taskbar_location,
	"dock.mode": option_values.dock_mode,
	"dock.position": option_values.dock_position,
	"dock.scale": { min: 50, max: 200, integer: true },
	"desktop.iconSize": option_values.desktop_icon_size,
	"launcher.position": option_values.launcher_position,
	"launcher.margin": { min: 0, max: 1000, integer: true },
	"launcher.scale": { min: 50, max: 200, integer: true },
	"launcher.apps.max": { min: 1, max: 9, integer: true },
	"favorites.location": option_values.favorites_location,
	"overview.scale": { min: 50, max: 200, integer: true },
	"overview.workspaces": { min: 0, max: 16, integer: true },
	"quicksettings.position": option_values.popup_position,
	"quicksettings.width": { min: 100, max: 1200, integer: true },
	"datemenu.position": option_values.date_menu_position,
	"powermenu.layout": option_values.power_menu_layout,
	"osd.position": option_values.osd_position,
	"osd.dismiss": { min: 0, max: 60000, integer: true },
	"notifications.position": option_values.popup_position,
	"notifications.dismiss": { min: 0, max: 60000, integer: true },
	"colorpicker.maxColors": { min: 1, max: 128, integer: true },
	"hyprland.gaps": { min: 0, max: 10 },
	"asus.ac_hz": { min: 1, max: 1000, integer: true },
	"asus.bat_hz": { min: 1, max: 1000, integer: true },
} as const

let launcher_icon = icons.ui.search
if (
	env.distro.logo &&
	new Gtk.IconTheme({ themeName: app.iconTheme }).has_icon(env.distro.logo)
)
	launcher_icon = env.distro.logo

const options = mk_options(
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
				icon: launcher_icon,
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

export function ui_scale(): number {
	return Math.max(0.1, options.scale() / 100)
}

export function surface_scale(source: Accessor<number>, min = 0): number {
	return Math.max(min, source() / 100)
}
