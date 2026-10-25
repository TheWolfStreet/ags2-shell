import GLib from "gi://GLib"
import { attempt, attempt_async, log_error } from "$lib/result"

export type timer = { cancel(): void }

function run_callback(callback: () => unknown) {
	const result = attempt(callback)
	if (!log_error(result, "timer: Callback failed")) return
	if (!(result.value instanceof Promise)) return
	const pending = result.value
	void attempt_async(() => pending).then((settled) =>
		log_error(settled, "timer: Callback failed"),
	)
}

function schedule(ms: number, callback: () => unknown, repeat: boolean): timer {
	let source = 0
	let cancelled = false
	const dispatch = () => {
		if (!repeat) source = 0
		if (!cancelled) run_callback(callback)
		return repeat && !cancelled ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE
	}
	if (ms === 0 && !repeat)
		source = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, dispatch)
	else
		source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), dispatch)
	return {
		cancel() {
			if (cancelled) return
			cancelled = true
			if (source) GLib.Source.remove(source)
			source = 0
		},
	}
}

export function timeout(ms: number, callback: () => unknown): timer {
	return schedule(ms, callback, false)
}

export function idle(callback: () => unknown): timer {
	return schedule(0, callback, false)
}

export function interval(ms: number, callback: () => unknown): timer {
	const repeating = schedule(ms, callback, true)
	const first = idle(callback)
	return {
		cancel() {
			repeating.cancel()
			first.cancel()
		},
	}
}

export function debounce<Args extends unknown[]>(
	ms: number,
	fn: (...args: Args) => void | Promise<void>,
) {
	let timer: timer | null = null
	return {
		get pending() {
			return timer !== null
		},
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
