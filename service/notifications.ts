import GObject, { getter, register } from "ags/gobject"
import { type Timer, timeout } from "$lib/time"

import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt } from "$lib/result"
import { notification_daemon } from "$lib/notifications"
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
	#owner_warning_timer: Timer | null = null
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
			this.#warn_if_not_daemon_owner()
		})
	}

	#warn_if_not_daemon_owner(): void {
		const result = attempt(() => {
			const connection = Gio.DBus.session
			connection.call(
				"org.freedesktop.DBus",
				"/org/freedesktop/DBus",
				"org.freedesktop.DBus",
				"GetNameOwner",
				GLib.Variant.new_tuple([
					GLib.Variant.new_string("org.freedesktop.Notifications"),
				]),
				new GLib.VariantType("(s)"),
				Gio.DBusCallFlags.NONE,
				1000,
				null,
				(_connection, response) => {
					const owner = attempt(
						() =>
							connection.call_finish(response).recursiveUnpack() as [string],
					)
					if (!owner.ok) {
						console.debug(
							"notifications: could not verify daemon bus ownership",
							owner.err,
						)
						return
					}
					if (owner.value[0] !== connection.get_unique_name())
						console.warn(
							`notifications: org.freedesktop.Notifications is owned by ${owner.value[0]}, not this shell (${connection.get_unique_name()})`,
						)
				},
			)
		})
		if (!result.ok)
			console.debug(
				"notifications: could not verify daemon bus ownership",
				result.err,
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
		const all = notification_daemon
			.get_notifications()
			.filter((notification) => !notification.transient)
		if (all.length <= (this.#pruning ? persist_keep : persist_trigger)) {
			this.#pruning = false
			return
		}
		this.#pruning = true

		const oldest = all
			.slice()
			.sort((left, right) => left.time - right.time)
			.slice(0, all.length - persist_keep)
		for (const notification of oldest.slice(0, prune_budget))
			notification.dismiss()
		if (oldest.length > prune_budget) this.#schedule_prune()
		else this.#pruning = false
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
