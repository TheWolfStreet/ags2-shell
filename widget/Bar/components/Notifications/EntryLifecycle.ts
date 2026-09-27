// Times notification animations, pauses expiry on hover, and handles user actions.

import { createState } from "ags"
import { timeout, Timer } from "ags/time"

import AstalNotifd from "gi://AstalNotifd"

import { attempt, logError } from "$lib/result"
import { notificationDaemon } from "$lib/notifications"
import options from "$shell/options"

type EntryLifecycleProps = {
	notification: AstalNotifd.Notification
	persistent: boolean
	onExit: () => void
}

export type EntryLifecycle = ReturnType<typeof createEntryLifecycle>

export function createEntryLifecycle({
	notification,
	persistent,
	onExit,
}: EntryLifecycleProps) {
	const [visible, setVisible] = createState(false)
	let autoHide: Timer | undefined
	let exitTimer: Timer | undefined
	let closing = false
	let exited = false

	const isCurrent = () =>
		notificationDaemon.get_notification(notification.id) === notification

	const exit = () => {
		if (exited) return
		exited = true
		exitTimer?.cancel()
		onExit()
	}

	const close = () => {
		if (closing) return
		closing = true
		autoHide?.cancel()
		if (!visible.peek()) {
			exit()
			return
		}
		setVisible(false)
		exitTimer = timeout(
			Math.max(100, options.transition.duration.peek() * 2),
			exit,
		)
	}

	const scheduleAutoHide = () => {
		if (persistent || closing) return
		autoHide?.cancel()
		autoHide = timeout(options.notifications.dismiss.peek(), close)
	}

	return {
		visible,
		isClosing: () => closing,
		close,
		dismiss() {
			if (isCurrent()) notification.dismiss()
			close()
		},
		onActionClick(actionId: string) {
			if (isCurrent()) {
				const result = attempt(() => notification.invoke(actionId))
				logError(result, "notifications.action: Failed to invoke notification action")
			}
			if (!persistent || !notification.resident) close()
		},
		keepAlive: scheduleAutoHide,
		onMap() {
			if (closing || visible.peek()) return
			setVisible(true)
			scheduleAutoHide()
		},
		onRevealedChanged(revealed: boolean) {
			if (closing && !revealed) exit()
		},
		cleanup() {
			autoHide?.cancel()
			exitTimer?.cancel()
			closing = true
			exited = true
		},
	}
}
