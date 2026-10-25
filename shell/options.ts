import { Accessor, createState, type Setter } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import app from "$lib/app"

import icons from "$lib/icons"
import env from "$lib/env"
import { ensure_file } from "$lib/files"
import {
	attempt,
	attempt_async,
	err,
	log_error,
	ok,
	type result,
} from "$lib/result"
import { debounce } from "$lib/time"
import { is_record } from "$lib/json"

namespace store {
	const path = `${env.paths.cache.base}/options.json`

	let cache: Record<string, unknown> | null = null

	let writes_blocked = false

	function ensure_loaded() {
		if (cache !== null) return
		cache = {}
		const ready = ensure_file(path)
		if (!log_error(ready, "option.store.load: Failed to prepare options store"))
			return
		const parsed = attempt(() => JSON.parse(readFile(path) || "{}") as unknown)
		if (!log_error(parsed, "option.store.load: Failed to load options store")) {
			set_aside_unreadable_store()
			return
		}
		if (!is_record(parsed.value)) {
			console.error(
				"option.store.load: Options store does not contain an object",
			)
			set_aside_unreadable_store()
			return
		}
		cache = parsed.value
	}

	function set_aside_unreadable_store() {
		const backup = `${path}.bad`
		const moved = attempt(() =>
			Gio.File.new_for_path(path).move(
				Gio.File.new_for_path(backup),
				Gio.FileCopyFlags.OVERWRITE,
				null,
				null,
			),
		)
		if (
			!log_error(
				moved,
				"option.store.load: Failed to set aside unreadable options",
			)
		) {
			writes_blocked = true
			return
		}
		console.error(`option.store.load: Unreadable options moved to ${backup}`)
	}

	let last_save: Promise<result<void>> = Promise.resolve(ok(undefined))
	let revision = 0
	let saved_revision = 0

	async function write_cache(): Promise<result<void>> {
		const ready = ensure_file(path)
		if (!ready.ok) return ready
		return attempt_async(async () => {
			await writeFileAsync(path, JSON.stringify(cache, null, 2))
		})
	}

	async function persist(): Promise<result<void>> {
		if (revision === saved_revision) return ok(undefined)
		if (writes_blocked)
			return err(new Error("Options store is unreadable and was not set aside"))
		const writing_revision = revision
		const written = await write_cache()
		if (written.ok) saved_revision = writing_revision
		log_error(written, "option.store.save: Failed to save options store")
		return written
	}

	function write(): Promise<result<void>> {
		last_save = last_save.then(persist)
		return last_save
	}

	const save = debounce(3000, () => {
		void write()
	})

	export function flush(): Promise<result<void>> {
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
			if (!is_record(node)) return undefined
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
			if (is_record(next)) {
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
			if (!is_record(next)) return
			node = next
		}
		delete node[parts[parts.length - 1]]
		revision++
		save.call()
	}
}

function same_leaf(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b))
		return (
			a.length === b.length &&
			a.every((value, index) => Object.is(value, b[index]))
		)
	return Object.is(a, b)
}

function snapshot_leaf<T>(value: T): T {
	return Array.isArray(value) ? (Object.freeze([...value]) as T) : value
}

type option_rule =
	| { kind: "choice"; values: readonly (string | number)[] }
	| { kind: "range"; min: number; max: number; integer: boolean }
	| { kind: "font" }
	| { kind: "color" }
	| { kind: "icon" }

export type option_editor =
	"enum" | "font" | "color" | "icon" | "boolean" | "number" | "string"

class Ruled<T> {
	constructor(
		readonly initial: T,
		readonly rule: option_rule,
	) {}
}

function choice<const T extends string>(initial: T, values: readonly T[]) {
	return new Ruled<T>(initial, { kind: "choice", values })
}

function range(initial: number, min: number, max: number, integer = true) {
	return new Ruled(initial, { kind: "range", min, max, integer })
}

function font(initial: string) {
	return new Ruled(initial, { kind: "font" })
}

function icon(initial: string) {
	return new Ruled(initial, { kind: "icon" })
}

function inferred_rule(initial: unknown): option_rule | null {
	if (typeof initial === "string" && initial.startsWith("#"))
		return { kind: "color" }
	return null
}

const default_range = { min: 0, max: 1000, integer: true }

export class Opt<T> extends Accessor<T> {
	#setter: Setter<T>
	#default: T
	readonly id: string
	readonly rule: option_rule | null

	constructor(
		initial: T,
		id: string,
		rule: option_rule | null,
		current: T = initial,
	) {
		const default_value = snapshot_leaf(initial)
		const [acc, set] = createState(
			same_leaf(current, default_value)
				? default_value
				: snapshot_leaf(current),
		)
		super(
			() => acc.peek(),
			(cb) => acc.subscribe(cb),
		)
		this.#setter = set
		this.#default = default_value
		this.id = id
		this.rule = rule
	}

	[Symbol.toPrimitive]() {
		console.warn(
			"option.coerce: Opt implicitly converted to a primitive value",
			new Error().stack,
		)
		return this.toString()
	}

	valid(value: unknown): boolean {
		return valid_leaf(value, this.#default, this.rule)
	}

	editor(): option_editor {
		if (this.rule?.kind === "choice") return "enum"
		if (this.rule?.kind === "font") return "font"
		if (this.rule?.kind === "color") return "color"
		if (this.rule?.kind === "icon") return "icon"
		if (typeof this.#default === "boolean") return "boolean"
		if (typeof this.#default === "number") return "number"
		return "string"
	}

	choices(): readonly (string | number)[] | null {
		return this.rule?.kind === "choice" ? this.rule.values : null
	}

	bounds(): { min: number; max: number } {
		const { min, max } = this.rule?.kind === "range" ? this.rule : default_range
		return { min, max }
	}

	set(v: T): result<void> {
		if (!this.valid(v)) {
			const result = err(new Error(`Invalid value for option ${this.id}`))
			log_error(result, "option.set: Rejected value")
			return result
		}
		if (same_leaf(this.peek(), v)) return ok(undefined)

		const value = same_leaf(v, this.#default) ? this.#default : snapshot_leaf(v)
		if (value === this.#default) store.del(this.id)
		else store.set(this.id, value)
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

type widen_literals<T> = T extends boolean
	? boolean
	: T extends string
		? string
		: T extends number
			? number
			: T

function valid_leaf(
	value: unknown,
	initial: unknown,
	rule: option_rule | null,
): boolean {
	if (rule?.kind === "choice")
		return rule.values.some((allowed) => Object.is(allowed, value))

	if (Array.isArray(initial))
		return (
			Array.isArray(value) &&
			value.length <= 128 &&
			value.every(
				(item) =>
					typeof item === typeof initial[0] &&
					typeof item === "string" &&
					item.length <= 256,
			)
		)
	if (typeof initial === "boolean") return typeof value === "boolean"
	if (typeof initial === "string") {
		if (typeof value !== "string" || value.length > 4096) return false
		if (rule?.kind === "font")
			return /^[^\n\r\\";{}]+\s+[1-9]\d*(?:\.\d+)?$/.test(value)
		if (rule?.kind === "color") return /^#[0-9a-f]{6}$/i.test(value)
		return !/[\x00-\x1f]/.test(value)
	}
	if (typeof initial === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) return false
		const bounds = rule?.kind === "range" ? rule : default_range
		return (
			value >= bounds.min &&
			value <= bounds.max &&
			(!bounds.integer || Number.isInteger(value))
		)
	}
	return false
}

type options<T> =
	T extends Ruled<infer V>
		? Opt<V>
		: T extends Record<string, unknown>
			? { [K in keyof T]: options<T[K]> }
			: Opt<widen_literals<T>>

function mk_options<T>(node: T): options<T> {
	return build_options(node, "") as options<T>
}

function build_options(node: unknown, path: string): unknown {
	if (is_record(node) && !(node instanceof Ruled)) {
		const built: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(node))
			built[key] = build_options(child, path ? `${path}.${key}` : key)
		return built
	}

	const initial = node instanceof Ruled ? node.initial : node
	const rule = node instanceof Ruled ? node.rule : inferred_rule(initial)
	const stored = path ? store.get(path) : undefined
	if (stored === undefined) return new Opt(initial, path, rule)
	if (valid_leaf(stored, initial, rule))
		return new Opt(initial, path, rule, stored)
	store.del(path)
	return new Opt(initial, path, rule)
}

export function flush_options(): Promise<result<void>> {
	return store.flush()
}

export function collect_options(opts: unknown): Opt<any>[] {
	if (opts instanceof Opt) return [opts]
	if (!is_record(opts)) return []
	return Object.values(opts).flatMap((child) => collect_options(child))
}

export function subscribe_options(
	opts: unknown,
	prefixes: readonly string[],
	callback: () => void,
): () => void {
	const disposers = collect_options(opts)
		.filter((opt) =>
			prefixes.some(
				(prefix) => opt.id === prefix || opt.id.startsWith(`${prefix}.`),
			),
		)
		.map((opt) => opt.subscribe(callback))
	return () => disposers.forEach((dispose) => dispose())
}

const popup_positions = [
	"top-left",
	"top-center",
	"top-right",
	"bottom-left",
	"bottom-center",
	"bottom-right",
] as const

function default_launcher_icon() {
	const logo = env.distro.logo
	if (!logo) return icons.ui.search
	if (!new Gtk.IconTheme({ themeName: app.iconTheme }).has_icon(logo))
		return icons.ui.search
	return logo
}

const options = mk_options({
	autotheme: false,
	scale: range(100, 50, 200),
	font: font("SFProDisplay Nerd Font 11"),
	transition: {
		duration: range(200, 0, 2000),
	},

	theme: {
		scheme: choice("dark", ["dark", "light"]),
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

		opacity: range(30, 0, 70),
		widget: {
			opacity: range(94, 0, 100),
		},
		border: {
			width: range(1, 0, 100),
			opacity: range(86, 0, 100),
		},
		shadows: true,
		blur: true,
		neumorphic: true,

		padding: range(8, 0, 50),
		spacing: range(6, 0, 50),
		roundness: range(12, 0, 50),
	},

	bar: {
		position: choice("top-center", ["top-center", "bottom-center"]),
		transparent: false,
		corners: range(50, 0, 100),

		launcher: {
			icon: icon(default_launcher_icon()),
		},
		workspaces: {
			count: range(7, 0, 16),
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
		location: choice("dock", ["bar", "dock"]),
	},

	dock: {
		mode: choice("static", ["static", "autohide"]),
		position: choice("bottom-center", ["bottom-center", "center-left"]),
		scale: range(100, 50, 200),
		trash: true,
	},

	desktop: {
		enabled: true,
		iconSize: choice("medium", ["small", "medium", "large", "extralarge"]),
	},

	launcher: {
		position: choice("top-center", ["top-center", "bottom-center"]),
		margin: range(40, 0, 1000),
		scale: range(100, 50, 200),
		apps: {
			max: range(6, 0, 1000),
		},
	},

	favorites: {
		location: choice("both", ["disabled", "dock", "launcher", "both"]),
	},

	overview: {
		scale: range(100, 50, 200),
		workspaces: range(7, 0, 16),
	},

	quicksettings: {
		position: choice("right", ["left", "center", "right"]),
		width: range(380, 100, 1200),
	},

	datemenu: {
		position: choice("center", ["left", "center", "right"]),
	},

	powermenu: {
		layout: choice("line", ["box", "line"]),
		labels: true,
		sleep: "systemctl suspend",
		reboot: "systemctl reboot",
		logout: "hyprctl dispatch 'hl.dsp.exit()'",
		shutdown: "shutdown now",
	},

	osd: {
		position: choice("bottom-center", ["center", "bottom-center"]),
		dismiss: range(1200, 0, 60000),
	},

	notifications: {
		position: choice("top-right", popup_positions),
		blacklist: ["Spotify", "com.spotify.Client"],
		dismiss: range(3500, 0, 60000),
	},

	colorpicker: {
		maxColors: range(10, 1, 128),
	},

	hyprland: {
		gaps: range(2.4, 0, 10, false),
		inactiveBorder: "#282828",
	},

	tmux: {
		accent: true,
	},

	asus: {
		ac_hz: range(144, 1, 1000),
		bat_hz: range(60, 1, 1000),
	},
})

export default options

export function scaled(px: number): Accessor<number> {
	return options.scale.as((scale) => Math.round((px * scale) / 100))
}

export function ui_scale(): number {
	return options.scale() / 100
}

export function surface_scale(source: Accessor<number>): number {
	return source() / 100
}
