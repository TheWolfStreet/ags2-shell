import GObject, { getter, register } from "ags/gobject"
import { type timer, timeout } from "$lib/time"

import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import {
	notification_daemon,
	notification_name_owner,
} from "$lib/notifications"
import options from "$shell/options"

const display_limit = 50
const persist_keep = 50
const persist_trigger = 75
const prune_budget = 8
const coalesce_ms = 16
const prune_delay_ms = 250

@register()
class NotificationManager extends GObject.Object {
	declare static $gtype: GObject.GType<NotificationManager>

	#store_handlers: number[] = []
	#coalesce_source_id: number | null = null
	#prune_source_id: number | null = null
	#pruning = false
	#owner_warning_timer: timer | null = null
	#unsubscribe_blacklist: () => void

	readonly session_start = Math.floor(Date.now() / 1000)

	constructor() {
		super()
		this.#store_handlers.push(
			notification_daemon.connect("notified", () => this.#on_store_changed()),
			notification_daemon.connect("resolved", () => this.#on_store_changed()),
		)
		this.#unsubscribe_blacklist = options.notifications.blacklist.subscribe(
			() => this.notify("notifications"),
		)
		this.#schedule_prune()
		this.#owner_warning_timer = timeout(5000, () => {
			this.#owner_warning_timer = null
			void this.#warn_if_not_daemon_owner()
		})
	}

	async #warn_if_not_daemon_owner(): Promise<void> {
		const owner = await notification_name_owner()
		if (!owner.ok) {
			console.debug(
				"notifications: Could not verify daemon bus ownership",
				owner.err,
			)
			return
		}
		const unique_name = Gio.DBus.session.get_unique_name()
		if (owner.value !== unique_name)
			console.warn(
				`notifications: The org.freedesktop.Notifications name is owned by ${owner.value}, not this shell (${unique_name})`,
			)
	}

	#on_store_changed(): void {
		this.#schedule_prune()
		if (this.#coalesce_source_id !== null) return

		this.#coalesce_source_id = GLib.timeout_add(
			GLib.PRIORITY_DEFAULT,
			coalesce_ms,
			() => {
				this.#coalesce_source_id = null
				this.notify("notifications")
				return GLib.SOURCE_REMOVE
			},
		)
	}

	@getter(Array)
	get notifications(): AstalNotifd.Notification[] {
		return notification_daemon
			.get_notifications()
			.filter((notification) => !this.is_blacklisted(notification))
			.sort((left, right) => right.time - left.time)
			.slice(0, display_limit)
	}

	is_blacklisted(notification: AstalNotifd.Notification): boolean {
		const app = notification.get_app_name() || notification.get_desktop_entry()
		return options.notifications.blacklist.peek().includes(app)
	}

	get do_not_disturb(): boolean {
		return notification_daemon.get_dont_disturb()
	}

	#schedule_prune(): void {
		if (this.#prune_source_id !== null) return
		this.#prune_source_id = GLib.timeout_add(
			GLib.PRIORITY_DEFAULT_IDLE,
			prune_delay_ms,
			() => {
				this.#prune_source_id = null
				this.#prune()
				return GLib.SOURCE_REMOVE
			},
		)
	}

	#prune(): void {
		const stored = notification_daemon
			.get_notifications()
			.filter((notification) => !notification.transient)
		const limit = this.#pruning ? persist_keep : persist_trigger
		if (stored.length <= limit) {
			this.#pruning = false
			return
		}

		const excess = stored
			.sort((left, right) => left.time - right.time)
			.slice(0, stored.length - persist_keep)
		for (const notification of excess.slice(0, prune_budget))
			notification.dismiss()
		this.#pruning = excess.length > prune_budget
		if (this.#pruning) this.#schedule_prune()
	}

	vfunc_finalize(): void {
		this.#owner_warning_timer?.cancel()
		if (this.#coalesce_source_id !== null)
			GLib.Source.remove(this.#coalesce_source_id)
		if (this.#prune_source_id !== null)
			GLib.Source.remove(this.#prune_source_id)
		for (const handler of this.#store_handlers)
			notification_daemon.disconnect(handler)
		this.#store_handlers = []
		this.#unsubscribe_blacklist()
		super.vfunc_finalize()
	}
}

export const notification_manager = new NotificationManager()
