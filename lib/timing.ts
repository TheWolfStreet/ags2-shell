// Delays repeated calls and lets callers run or cancel the latest one.

import { Timer, timeout } from "ags/time"

export function debounce<Args extends unknown[]>(ms: number, fn: (...args: Args) => void | Promise<void>) {
	let timer: Timer | null = null
	return {
		get pending() {
			return timer !== null
		},
		call(...args: Args) {
			timer?.cancel()
			timer = timeout(ms, async () => {
				timer = null
				await fn(...args)
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
