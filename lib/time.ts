import GLib from "gi://GLib"

export type Timer = { cancel(): void }

function schedule(ms: number, callback: () => unknown, repeat: boolean, immediate = false): Timer {
	let source = 0
	let first = 0
	let cancelled = false
	const invoke = () => {
		if (cancelled) return
		try {
			const result = callback()
			if (result instanceof Promise)
				void result.catch(error => console.error("timer: Callback failed", error))
		} catch (error) {
			console.error("timer: Callback failed", error)
		}
	}
	const dispatch = () => {
		if (!repeat) source = 0
		invoke()
		return repeat && !cancelled ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE
	}
	if (ms === 0 && !repeat) source = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, dispatch)
	else source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), dispatch)
	if (immediate) first = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
		first = 0
		invoke()
		return GLib.SOURCE_REMOVE
	})
	return {
		cancel() {
			if (cancelled) return
			cancelled = true
			if (source) GLib.Source.remove(source)
			if (first) GLib.Source.remove(first)
			source = 0
			first = 0
		},
	}
}

export function timeout(ms: number, callback: () => unknown): Timer {
	return schedule(ms, callback, false)
}

export function idle(callback: () => unknown): Timer {
	return schedule(0, callback, false)
}

export function interval(ms: number, callback: () => unknown): Timer {
	return schedule(ms, callback, true, true)
}

export function debounce<Args extends unknown[]>(ms: number, fn: (...args: Args) => void | Promise<void>) {
	let timer: Timer | null = null
	return {
		get pending() { return timer !== null },
		call(...args: Args) {
			timer?.cancel()
			timer = timeout(ms, () => {
				timer = null
				return fn(...args)
			})
		},
		flush(...args: Args) {
			timer?.cancel()
			timer = null
			return fn(...args)
		},
		cancel() {
			timer?.cancel()
			timer = null
		},
	}
}

export function format_clock(length: number) {
	const hours = Math.floor(length / 3600)
	const minutes = Math.floor((length % 3600) / 60)
	const seconds = Math.floor(length % 60)
	const mm = minutes.toString().padStart(hours ? 2 : 1, "0")
	const ss = seconds.toString().padStart(2, "0")
	return hours ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`
}
