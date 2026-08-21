// Times notification animations, pauses expiry on hover, and handles user actions.

import { Accessor, createState } from "ags"
import { timeout, Timer } from "ags/time"

import AstalNotifd from "gi://AstalNotifd"

import { attempt } from "$lib/result"
import { readValue } from "$lib/ui"
import { notificationManager } from "$service/notifications"
import options from "$shell/options"

export type EntryIndex = Accessor<number> | number | undefined

type EntryLifecycleProps = {
	notification: AstalNotifd.Notification
	persistent: boolean
	index: EntryIndex
	dismissingAll: Accessor<boolean>
	onExit?: () => void
}

export function staggerDelay(index: number) {
	return index * 50 + Math.random() * 100
}

export function createEntryLifecycle({
	notification,
	persistent,
	index,
	dismissingAll,
	onExit,
}: EntryLifecycleProps) {
	const [visible, setVisible] = createState(false)
	let autoHide: Timer | undefined
	let staggeredHide: Timer | undefined
	let pendingTimer: Timer | undefined
	let pendingAction: (() => void) | undefined
	let initialRevealHandled = false
	let closing = false

	const cancelAutoHide = () => {
		autoHide?.cancel()
		autoHide = undefined
	}

	const beginClose = (action?: () => void) => {
		if (closing) return
		closing = true
		cancelAutoHide()
		pendingAction = action
		pendingTimer = timeout(Math.max(100, options.transition.duration.peek() * 2), completePendingAction)
		setVisible(false)
	}

	const completePendingAction = () => {
		pendingTimer?.cancel()
		pendingTimer = undefined
		const action = pendingAction
		pendingAction = undefined
		if (action) {
			const result = attempt(action)
			if (!result.ok)
				console.error("notifications.action: Failed to complete notification action", result.err)
		}
		onExit?.()
	}

	const scheduleAutoHide = (stagger = false) => {
		if (persistent || closing) return

		cancelAutoHide()
		const entryIndex = readValue(index)
		const delay = options.notifications.dismiss.peek()
			+ (stagger && entryIndex !== undefined ? staggerDelay(entryIndex) : 0)
		autoHide = timeout(delay, () => {
			beginClose()
			autoHide = undefined
		})
	}

	const dismiss = () => beginClose(() => notification.dismiss())
	const onActionClick = (actionId: string) => {
		if (persistent && notification.resident) {
			const result = attempt(() => notification.invoke(actionId))
			if (!result.ok)
				console.error("notifications.action: Failed to invoke resident notification action", result.err)
			return
		}
		beginClose(() => notification.invoke(actionId))
	}

	const onDismissAllChanged = () => {
		const entryIndex = readValue(index)
		if (dismissingAll.peek() && entryIndex !== undefined) {
			staggeredHide?.cancel()
			staggeredHide = timeout(staggerDelay(entryIndex), () => {
				beginClose()
				staggeredHide = undefined
			})
		}
	}

	const isFresh = persistent || notification.time >= notificationManager.sessionStart
	const onMap = () => {
		if (!closing && !initialRevealHandled && isFresh && (!notificationManager.doNotDisturb || persistent)) {
			setVisible(true)
			initialRevealHandled = true
			scheduleAutoHide()
		}
	}

	// GTK can miss the settled signal during teardown, so the guarded timer completes the same action once.
	const onHidden = (hidden: boolean) => {
		if (hidden) completePendingAction()
	}

	return {
		visible,
		close: () => beginClose(),
		dismiss,
		onActionClick,
		onDismissAllChanged,
		keepAlive: () => scheduleAutoHide(),
		onMap,
		onHidden,
		cleanup() {
			cancelAutoHide()
			staggeredHide?.cancel()
			pendingTimer?.cancel()
			pendingAction = undefined
			closing = true
		},
	}
}
