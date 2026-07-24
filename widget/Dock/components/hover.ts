// Watches the pointer around the dock and delays hiding after it leaves.

import { createState } from "ags"
import { timeout, Timer } from "ags/time"

const HIDE_DELAY_MS = 250

export type Hover = ReturnType<typeof createHover>

export function createHover(delayMs = HIDE_DELAY_MS) {
	const [hovered, setHovered] = createState(false)
	const zones = new Set<string>()
	let hideTimer: Timer | undefined

	const cancelHide = () => {
		hideTimer?.cancel()
		hideTimer = undefined
	}

	const scheduleHide = () => {
		cancelHide()
		hideTimer = timeout(delayMs, () => setHovered(false))
	}

	const leaveZone = (zone: string) => {
		zones.delete(zone)
		if (zones.size === 0)
			scheduleHide()
	}

	return {
		hovered,
		enter: (zone: string) => {
			zones.add(zone)
			cancelHide()
			if (!hovered())
				setHovered(true)
		},
		leave: leaveZone,
		destroy: () => {
			zones.clear()
			cancelHide()
		},
	}
}
