import { Timer, timeout } from "ags/time"

export function debounce(ms: number, fn: () => void | Promise<void>) {
	let timer: Timer | null = null
	return {
		call() {
			timer?.cancel()
			timer = timeout(ms, async () => {
				timer = null
				await fn()
			})
		},
		cancel() {
			timer?.cancel()
			timer = null
		},
	}
}
