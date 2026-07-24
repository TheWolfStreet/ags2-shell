// Formats clocks, elapsed times, and durations for display.

import GLib from "gi://GLib"

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

export function timeAgo(time: number) {
	const now = GLib.DateTime.new_now_local()
	const then = GLib.DateTime.new_from_unix_local(time)
	if (!then) return ""
	const diff = now.to_unix() - then.to_unix()
	if (diff < 60) return "now"
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
	return `${Math.floor(diff / 86400)}d ago`
}

export function formatDuration(seconds: number): string {
	if (seconds === 0)
		return ""

	const days = Math.floor(seconds / (24 * 60 * 60))
	const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60))
	const minutes = Math.floor((seconds % (60 * 60)) / 60)
	const secs = seconds % 60

	const parts: string[] = []

	if (days > 0)
		parts.push(`${days}d`)

	if (hours > 0 || days > 0)
		parts.push(`${hours}h`)

	if (minutes > 0 || hours > 0 || days > 0)
		parts.push(`${minutes}m`)

	parts.push(`${secs}s`)

	return parts.join(" ")
}
