import app from "ags/gtk4/app"
import { Gdk } from "ags/gtk4"
import { createRoot, createState, onCleanup } from "ags"
import { idle, Timer } from "ags/time"

import { Bar } from "widget/Bar"
import { Dock } from "widget/Dock"
import { Desktop } from "widget/Desktop"

export type MonitorControl = {
	park(): void
	unpark(mon: Gdk.Monitor): void
}

export function trackMonitorGeometry(initial: Gdk.Monitor) {
	let mon = initial
	const [geometry, setGeometry] = createState(initial.get_geometry())
	const sync = () => setGeometry(mon.get_geometry())
	let handler = mon.connect("notify::geometry", sync)
	onCleanup(() => mon.disconnect(handler))

	return {
		geometry,
		retarget(next: Gdk.Monitor) {
			if (mon !== next) {
				mon.disconnect(handler)
				mon = next
				handler = mon.connect("notify::geometry", sync)
			}
			sync()
		},
	}
}

type Kind = "bar" | "dock" | "desktop" | "context"

type Built = {
	dispose: () => void
	control?: MonitorControl
}

type Builder = (mon: Gdk.Monitor, control: Partial<MonitorControl> | undefined, initialVisible: boolean) => void

const builders: Record<Kind, Builder> = {
	bar: (mon, control, initialVisible) => Bar({ gdkmonitor: mon, control, initialVisible }),
	dock: (mon, control, initialVisible) => Dock.Window({ gdkmonitor: mon, control, initialVisible }),
	desktop: mon => Desktop.Window({ gdkmonitor: mon }),
	context: mon => Desktop.ContextMenuWindow({ gdkmonitor: mon }),
}

const KINDS: Kind[] = ["bar", "dock", "desktop", "context"]
const POOLABLE = new Set<Kind>(["bar", "dock"])

function buildOne(kind: Kind, mon: Gdk.Monitor, initialVisible: boolean): Built {
	const control: Partial<MonitorControl> | undefined = POOLABLE.has(kind) ? {} : undefined
	const dispose = createRoot(d => {
		builders[kind](mon, control, initialVisible)
		return d
	})
	return { dispose, control: control as MonitorControl | undefined }
}

type Slot = {
	built: Map<Kind, Built>
	cancel: () => void
}

const active = new Map<string, Slot>()
const spares = new Map<Kind, Built>()

function keyOf(mon: Gdk.Monitor): string {
	return mon.get_connector() ?? `mon-${mon.get_geometry().x}x${mon.get_geometry().y}`
}

function refillSpares() {
	const anchor = app.get_monitors()[0]
	if (!anchor) return
	for (const kind of POOLABLE)
		if (!spares.has(kind))
			spares.set(kind, buildOne(kind, anchor, false))
}

function onConnect(mon: Gdk.Monitor) {
	const key = keyOf(mon)
	if (active.has(key)) return

	const built = new Map<Kind, Built>()
	const slot: Slot = { built, cancel: () => { } }
	active.set(key, slot)

	const steps: Array<() => void> = []
	for (const kind of KINDS) {
		const spare = spares.get(kind)
		if (spare) {
			spares.delete(kind)
			spare.control?.unpark(mon)
			built.set(kind, spare)
		} else {
			steps.push(() => built.set(kind, buildOne(kind, mon, true)))
		}
	}

	let idx = 0
	let cancelled = false
	let timer: Timer | null = null

	const step = () => {
		timer = null
		if (cancelled || idx >= steps.length) {
			if (!cancelled) idle(refillSpares)
			return
		}
		steps[idx++]()
		timer = idle(step)
	}
	timer = idle(step)

	slot.cancel = () => {
		cancelled = true
		timer?.cancel()
	}
}

function onDisconnect(key: string) {
	const slot = active.get(key)
	if (!slot) return

	active.delete(key)
	slot.cancel()

	for (const [kind, built] of slot.built) {
		if (POOLABLE.has(kind) && !spares.has(kind) && built.control) {
			built.control.park()
			spares.set(kind, built)
		} else {
			built.dispose()
		}
	}
}

export function initMonitors() {
	let known = new Map<string, Gdk.Monitor>()

	const sync = () => {
		const current = new Map<string, Gdk.Monitor>()
		for (const mon of app.get_monitors())
			current.set(keyOf(mon), mon)

		for (const key of known.keys())
			if (!current.has(key))
				onDisconnect(key)

		for (const [key, mon] of current)
			if (!known.has(key))
				onConnect(mon)

		known = current
	}

	app.connect("notify::monitors", sync)
	sync()
}
