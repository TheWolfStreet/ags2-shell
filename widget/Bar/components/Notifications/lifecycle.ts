// Times notification animations, pauses expiry on hover, and delays actions.

import { Accessor } from "ags"
import { timeout, Timer } from "ags/time"

import AstalNotifd from "gi://AstalNotifd"

import { notificationManager } from "$service/notifications"
import options from "options"

export type EntryIndex = Accessor<number> | number | undefined

export type VisibilityController = {
	value: Accessor<boolean>
	show: () => void
	hide: () => void
}

type EntryLifecycleProps = {
	notification: AstalNotifd.Notification
	persistent: boolean
	index: EntryIndex
	visibility: VisibilityController
	popupHovered: Accessor<boolean>
	dismissingAll: Accessor<boolean>
}

export function staggerDelay(index: number) {
	return index * 50 + Math.random() * 100
}

function resolveEntryIndex(index: EntryIndex) {
	if (index === undefined) return undefined
	return typeof index === "function" ? index.peek() : index
}

export function createEntryLifecycle({
	notification,
	persistent,
	index,
	visibility,
	popupHovered,
	dismissingAll,
}: EntryLifecycleProps) {
	let autoHide: Timer | undefined
	let staggeredHide: Timer | undefined
	let pendingAction: (() => void) | undefined
	let initialRevealHandled = false

	const cancelAutoHide = () => {
		autoHide?.cancel()
		autoHide = undefined
	}

	const scheduleAutoHide = (stagger = false) => {
		if (persistent) return

		cancelAutoHide()
		const entryIndex = resolveEntryIndex(index)
		const delay = options.notifications.dismiss.peek()
			+ (stagger && entryIndex !== undefined ? staggerDelay(entryIndex) : 0)
		autoHide = timeout(delay, () => {
			if (!popupHovered.peek()) visibility.hide()
			autoHide = undefined
		})
	}

	const queuePendingAction = (action: () => void) => {
		cancelAutoHide()
		pendingAction = action
		visibility.hide()
	}

	const dismiss = () => queuePendingAction(() => notification.dismiss())
	const onActionClick = (actionId: string) => queuePendingAction(() => {
		notification.invoke(actionId)
		notification.dismiss()
	})

	const onDismissAllChanged = () => {
		const entryIndex = resolveEntryIndex(index)
		if (dismissingAll.peek() && entryIndex !== undefined) {
			staggeredHide?.cancel()
			staggeredHide = timeout(staggerDelay(entryIndex), () => {
				visibility.hide()
				staggeredHide = undefined
			})
		}
	}

	const onPopupHoveredChanged = () => {
		if (persistent) return
		if (popupHovered.peek()) cancelAutoHide()
		else if (visibility.value.peek()) scheduleAutoHide(true)
	}

	const isFresh = persistent || notification.time >= notificationManager.sessionStart
	const onMap = () => {
		if (!initialRevealHandled && isFresh && (!notificationManager.dontDisturb || persistent)) {
			visibility.show()
			initialRevealHandled = true
			scheduleAutoHide()
		}
	}

	// Dismiss and action effects execute only after the closing reveal animation completes.
	const onChildRevealed = (isRevealChild: boolean) => {
		if (!isRevealChild && pendingAction) {
			pendingAction()
			pendingAction = undefined
		}
	}

	return {
		dismiss,
		onActionClick,
		onDismissAllChanged,
		onPopupHoveredChanged,
		onMap,
		onChildRevealed,
		cleanup() {
			cancelAutoHide()
			staggeredHide?.cancel()
		},
	}
}
