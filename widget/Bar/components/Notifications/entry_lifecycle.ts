import { createState } from "ags"
import { timeout, type timer } from "$lib/time"

import AstalNotifd from "gi://AstalNotifd"

import { attempt, log_error } from "$lib/result"
import { notification_daemon } from "$lib/notifications"
import options from "$shell/options"

type entry_lifecycle_props = {
	notification: AstalNotifd.Notification
	persistent: boolean
	on_exit: () => void
}

export type entry_lifecycle = ReturnType<typeof create_entry_lifecycle>

export function is_live(notification: AstalNotifd.Notification) {
	return notification_daemon.get_notification(notification.id) === notification
}

export function create_entry_lifecycle({
	notification,
	persistent,
	on_exit,
}: entry_lifecycle_props) {
	const [visible, set_visible] = createState(false)
	let auto_hide: timer | undefined
	let exit_timer: timer | undefined
	let closing = false
	let exited = false
	let hovered = false

	const exit = () => {
		if (exited) return
		exited = true
		exit_timer?.cancel()
		on_exit()
	}

	const close = () => {
		if (closing) return
		closing = true
		auto_hide?.cancel()
		if (!visible.peek()) {
			exit()
			return
		}
		set_visible(false)
		exit_timer = timeout(
			Math.max(100, options.transition.duration.peek() * 2),
			exit,
		)
	}

	const schedule_auto_hide = () => {
		if (persistent || closing || hovered) return
		auto_hide?.cancel()
		auto_hide = timeout(options.notifications.dismiss.peek(), close)
	}

	return {
		visible,
		is_closing: () => closing,
		close,
		dismiss() {
			if (is_live(notification)) notification.dismiss()
			close()
		},
		on_action_click(action_id: string) {
			if (is_live(notification))
				log_error(
					attempt(() => notification.invoke(action_id)),
					"notifications.action: Failed to invoke notification action",
				)
			if (!persistent || !notification.resident) close()
		},
		keep_alive() {
			hovered = true
			auto_hide?.cancel()
		},
		resume() {
			hovered = false
			schedule_auto_hide()
		},
		on_map() {
			if (closing || visible.peek()) return
			set_visible(true)
			schedule_auto_hide()
		},
		on_revealed_changed(revealed: boolean) {
			if (closing && !revealed) exit()
		},
		cleanup() {
			auto_hide?.cancel()
			exit_timer?.cancel()
			closing = true
			exited = true
		},
	}
}
