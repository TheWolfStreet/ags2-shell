// Formats elapsed times and schedules delayed work.

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

export function formatClock(length: number) {
	const hours = Math.floor(length / 3600)
	const minutes = Math.floor((length % 3600) / 60)
	const seconds = Math.floor(length % 60)

	const mm = minutes.toString().padStart(hours ? 2 : 1, "0")
	const ss = seconds.toString().padStart(2, "0")

	return hours
		? `${hours}:${mm}:${ss}`
		: `${minutes}:${ss}`
}
