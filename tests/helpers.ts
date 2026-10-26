import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { load_module } from "./load_module.ts"

export type node = {
	type: unknown
	props: Record<string, any>
	[key: string]: any
}

export function tick() {
	return new Promise((resolve) => setImmediate(resolve))
}

export function accessor(
	get: () => any,
	subscribe = (_callback: () => void) => () => {},
): any {
	function call(compute?: (value) => unknown) {
		if (compute) return accessor(() => compute(get()), subscribe)
		return get()
	}
	return Object.assign(call, {
		peek: get,
		subscribe,
		as: (compute: (value) => unknown) =>
			accessor(() => compute(get()), subscribe),
	})
}

export function read(value) {
	return typeof value === "function" ? value() : value
}

export function create_state(initial) {
	let value = initial
	const subscribers = new Set<() => void>()
	const get = accessor(() => value, subscribe_set(subscribers))
	function set(next) {
		value = typeof next === "function" ? next(value) : next
		for (const callback of [...subscribers]) callback()
	}
	return [get, set, subscribers] as const
}

export function make(type, props: Record<string, any> = {}) {
	if (typeof type === "function") return type(props)
	const children = Array.isArray(props.children)
		? props.children
		: [props.children]
	return { type, props, children: children.filter(Boolean) }
}

export const jsx_runtime = {
	jsx: make,
	jsxs: make,
	Fragment: ({ children }) => children,
}

function is_node(value): value is node {
	return Boolean(value) && typeof value === "object" && "props" in value
}

function walk(value): any[] {
	if (Array.isArray(value)) return value.flatMap(walk)
	if (!is_node(value)) return []
	const props = value.props
	if (value.type === "with")
		return [value, ...walk(props.children(props.value()))]
	if (value.type === "for")
		return [value, ...walk(props.each().map(props.children))]
	return [value, ...Object.values(props).flatMap(walk)]
}

export function nodes(root, type?: unknown): any[] {
	const found = walk(root)
	if (type === undefined) return found
	return found.filter((node) => node.type === type)
}

export function shell_quote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`
}

export function available(command: string) {
	return spawnSync("which", [command], { stdio: "ignore" }).status === 0
}

export function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function wayland_socket(runtime: string) {
	return readdirSync(runtime).find(
		(name) =>
			/^wayland-\d+$/.test(name) && statSync(join(runtime, name)).isSocket(),
	)
}

export function create_binding(object, ...path) {
	return accessor(() => path.reduce((value, key) => value?.[key], object))
}

export function render_with({ value, children }) {
	return children(value())
}

export function render_for({ each, children }) {
	return each().map(children)
}

export function for_node(props) {
	return make("for", props)
}

export function with_node(props) {
	return make("with", props)
}

export function noop_timer() {
	return { cancel() {} }
}

export function immediate_idle(callback) {
	return callback()
}

export function immediate_debounce(_ms, callback) {
	return { call: callback, cancel() {} }
}

export type fake_timer = {
	ms: number
	callback: () => void
	cancelled: boolean
	cancel(): void
}

export function capture_timer(timers: fake_timer[]) {
	return (ms: number, callback: () => void) => {
		const timer = {
			ms,
			callback,
			cancelled: false,
			cancel() {
				this.cancelled = true
			},
		}
		timers.push(timer)
		return timer
	}
}

export type fake_idle = Omit<fake_timer, "ms">

export function capture_idle(timers: fake_idle[]) {
	return (callback: () => void) => {
		const timer = {
			callback,
			cancelled: false,
			cancel() {
				this.cancelled = true
			},
		}
		timers.push(timer)
		return timer
	}
}

export function queued_idle(callbacks: (() => void)[]) {
	return (callback: () => void) => {
		callbacks.push(callback)
		return { cancel: () => callbacks.splice(callbacks.indexOf(callback), 1) }
	}
}

export function run_idles(timers: fake_idle[]) {
	for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback()
}

export function run_cleanups(cleanups: (() => void)[]) {
	for (const cleanup of cleanups) cleanup()
}

export function state_scope() {
	const subscribers = new Set<() => void>()
	function make_accessor(read) {
		return Object.assign(() => read(), {
			peek: read,
			subscribe: subscribe_set(subscribers),
			as: (fn) => make_accessor(() => fn(read())),
		})
	}
	function state<T>(initial: T) {
		let value = initial
		return [
			make_accessor(() => value),
			(next: T) => {
				value = next
				for (const callback of [...subscribers]) callback()
			},
		] as const
	}
	return { make_accessor, state }
}

export function make_flat(type, props: Record<string, any> = {}) {
	if (typeof type === "function") return type(props)
	const children = [props.children ?? []].flat(Infinity)
	return { type, props, children }
}

function mutable_node(type, props: Record<string, any> = {}) {
	return {
		...make(type, props),
		insert_child_after(child, previous) {
			this.children.splice(
				previous ? this.children.indexOf(previous) + 1 : 0,
				0,
				child,
			)
		},
		remove(child) {
			this.children.splice(this.children.indexOf(child), 1)
		},
	}
}

export function make_mutable(type, props: Record<string, any> = {}) {
	if (typeof type === "function") return type(props)
	return mutable_node(type, props)
}

type listener = { event: string; callback: (...args: any[]) => void }

export function emitter<T extends object>({ fields = {} as T } = {}) {
	let next = 1
	const listeners = new Map<number, listener>()
	return Object.assign(fields, {
		listeners,
		connect(event: string, callback: (...args: any[]) => void) {
			const id = next++
			listeners.set(id, { event, callback })
			return id
		},
		disconnect(id: number) {
			assert.ok(listeners.delete(id))
		},
		emit(event: string, ...args: any[]) {
			for (const listener of [...listeners.values()])
				if (listener.event === event) listener.callback(this, ...args)
		},
	})
}

export function glib_clock() {
	const sources = new Map<number, { ms: number; callback: () => boolean }>()
	const added: string[] = []
	const removed: number[] = []
	let next = 1
	function add(kind: string, priority: number, callback, ms?: number) {
		const id = next++
		sources.set(id, { ms: ms ?? 0, callback })
		added.push(`${id}:${kind}:${priority}${ms === undefined ? "" : `:${ms}`}`)
		return id
	}
	return {
		sources,
		added,
		removed,
		tick(id: number) {
			const source = sources.get(id)
			assert.ok(source)
			const keep = source.callback()
			if (!keep) sources.delete(id)
			return keep
		},
		run(ms: number) {
			for (const [id, source] of [...sources])
				if (source.ms === ms && sources.has(id)) {
					sources.delete(id)
					source.callback()
				}
		},
		glib: {
			PRIORITY_DEFAULT: 0,
			PRIORITY_DEFAULT_IDLE: 200,
			SOURCE_REMOVE: false,
			SOURCE_CONTINUE: true,
			timeout_add: (priority, ms, callback) =>
				add("timeout", priority, callback, ms),
			idle_add: (priority, callback) => add("idle", priority, callback),
			Source: {
				remove: (id: number) => {
					removed.push(id)
					assert.ok(sources.delete(id))
				},
			},
		},
	}
}

type hyprland_stub = { message_async?: (message: string) => Promise<string> }
type timer_stub = (ms: number, callback: () => void) => { cancel(): void }

export function load_hyprland({
	hyprland = {},
	app = {},
	timeout = noop_timer,
}: {
	hyprland?: object
	app?: object
	timeout?: timer_stub
} = {}): Promise<Record<string, any>> {
	return load_module("lib/hyprland.ts", {
		"gi://AstalHyprland": { default: { get_default: () => hyprland } },
		"gi://GLib": {
			default: {
				LogLevelFlags: { LEVEL_CRITICAL: 0 },
				log_set_handler: () => 0,
				log_remove_handler: () => {},
			},
		},
		"$lib/app": { default: app },
		"$lib/time": { timeout },
	})
}

let routed: hyprland_stub = {}
let shared: Promise<Record<string, any>> | undefined

export function with_hyprland_command<T extends { hyprland: object }>(
	module: T,
) {
	return {
		...module,
		hyprland_command: async (message: string) => {
			shared ??= load_hyprland({
				hyprland: {
					message_async: (command: string) => routed.message_async!(command),
				},
			})
			const loaded = await shared
			routed = module.hyprland
			return loaded.hyprland_command(message)
		},
	}
}

export class string_object {
	declare value: string
	constructor(value: string) {
		this.value = value
	}
	get_string() {
		return this.value
	}
	static $gtype = "GtkStringObject"
}

export function capture_log(calls: unknown[][]) {
	return (...args: unknown[]) => {
		if (!String(args[0]).includes("ExperimentalWarning")) calls.push(args)
	}
}

export async function flush_ticks({ turns = 4 } = {}) {
	for (let i = 0; i < turns; i++) await tick()
}

export function push_idle(callbacks: (() => void)[]) {
	return (callback: () => void) => callbacks.push(callback)
}

export function subscribe_set(subscribers: Set<() => void>) {
	return (callback: () => void) => {
		subscribers.add(callback)
		return () => subscribers.delete(callback)
	}
}

export function subscribe_list(subscribers: (() => void)[]) {
	return (callback: () => void) => {
		subscribers.push(callback)
		return () => {}
	}
}

export function on_shutdown(callbacks: (() => void)[]) {
	return (signal: string, callback: () => void) => {
		assert.equal(signal, "shutdown")
		callbacks.push(callback)
	}
}

export class variant {
	value: unknown
	constructor(_type, value) {
		this.value = value
	}
}

export function signals() {
	const handlers = new Map<number, [string, (...args: any[]) => void]>()
	let serial = 0
	return {
		handlers,
		connect(signal: string, callback: (...args: any[]) => void) {
			handlers.set(++serial, [signal, callback])
			return serial
		},
		disconnect(id: number) {
			assert.equal(handlers.delete(id), true)
		},
		emit(signal: string, ...args: any[]) {
			for (const [name, callback] of [...handlers.values()])
				if (name === signal) callback(...args)
		},
		count(signal: string) {
			return [...handlers.values()].filter(([name]) => name === signal).length
		},
	}
}

export function load_gnim_state({
	scope = { Scope: class {} },
}: { scope?: Record<string, any> } = {}) {
	return load_module("node_modules/gnim/dist/jsx/state.ts", {
		"gi://GObject": {
			default: {
				Object: class {
					connect() {}
					disconnect() {}
				},
				TYPE_JSOBJECT: 1,
			},
		},
		"gi://Gio": { default: {} },
		"gi://GLib": { default: {} },
		"../util.js": { camelify: (value) => value, kebabify: (value) => value },
		"./scope.js": scope,
	})
}

export function gobject_stub(notify: (name: string, object: any) => unknown) {
	return {
		default: {
			Object: class {
				notify(name: string) {
					notify(name, this)
				}
				vfunc_finalize() {}
			},
		},
		getter: () => () => {},
		register: () => (value) => value,
	}
}

export const gobject_registration = {
	default: { registerClass: (type) => type },
}

export const capture_kinds = {
	screenshot: {
		app_name: "Screenshot",
		summary: "Screenshot taken",
		directory: "/home/user/Pictures/Screenshots/",
	},
	recording: {
		app_name: "Recorder",
		summary: "Recording saved",
		directory: "/home/user/Videos/Screencasting/",
	},
}

export const revealer_transitions = {
	SLIDE_DOWN: 1,
	SLIDE_UP: 2,
	SWING_RIGHT: 3,
	SWING_DOWN: 4,
}
