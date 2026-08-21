// Maintains filtered notification history and bounded persistence.

import GObject, { getter, register } from "ags/gobject"
import { Timer, timeout } from "ags/time"

import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt } from "$lib/result"
import { notificationDaemon } from "$lib/notifications"
import options from "$shell/options"

const DISPLAY_LIMIT = 50
const PERSIST_KEEP = 50
const PERSIST_TRIGGER = 75
const PRUNE_BUDGET = 8
const COALESCE_MS = 16
const PRUNE_DELAY_MS = 250

@register()
class NotificationManager extends GObject.Object {
	declare static $gtype: GObject.GType<NotificationManager>

	#storeHandlers: number[] = []
	#coalesceSourceId: number | null = null
	#pruneSourceId: number | null = null
	#ownerWarningTimer: Timer | null = null
	#unsubscribeBlacklist: () => void

	readonly sessionStart = Math.floor(Date.now() / 1000)

	constructor() {
		super()
		this.#storeHandlers.push(
			notificationDaemon.connect("notified", () => this.#onStoreChanged()),
			notificationDaemon.connect("resolved", () => this.#onStoreChanged()),
		)
		this.#unsubscribeBlacklist = options.notifications.blacklist.subscribe(() =>
			this.notify("notifications"),
		)
		this.#schedulePrune()
		this.#ownerWarningTimer = timeout(5000, () => {
			this.#ownerWarningTimer = null
			this.#warnIfNotDaemonOwner()
		})
	}

	#warnIfNotDaemonOwner(): void {
		const result = attempt(() => {
			const connection = Gio.DBus.session
			const reply = connection.call_sync(
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
			)
			const [owner] = reply.recursiveUnpack() as [string]
			if (owner !== connection.get_unique_name())
				console.warn(
					`notifications: org.freedesktop.Notifications is owned by ${owner}, not this shell (${connection.get_unique_name()}) — a squatting process will steal notifications and desync the list`,
				)
		})
		if (!result.ok)
			console.debug(
				"notifications: could not verify daemon bus ownership",
				result.err,
			)
	}

	#onStoreChanged(): void {
		this.#schedulePrune()
		if (this.#coalesceSourceId !== null) return

		this.#coalesceSourceId = GLib.timeout_add(
			GLib.PRIORITY_DEFAULT,
			COALESCE_MS,
			() => {
				this.#coalesceSourceId = null
				this.notify("notifications")
				return GLib.SOURCE_REMOVE
			},
		)
	}

	@getter(Array)
	get notifications(): AstalNotifd.Notification[] {
		return notificationDaemon
			.get_notifications()
			.filter((notification) => !this.isBlacklisted(notification))
			.sort((left, right) => right.time - left.time)
			.slice(0, DISPLAY_LIMIT)
	}

	isBlacklisted(notification: AstalNotifd.Notification): boolean {
		const app = notification.get_app_name() || notification.get_desktop_entry()
		return options.notifications.blacklist.peek().includes(app)
	}

	dismissAllImmediately(): void {
		for (const notification of notificationDaemon.get_notifications())
			notification.dismiss()
	}

	get doNotDisturb(): boolean {
		return notificationDaemon.get_dont_disturb()
	}

	#schedulePrune(): void {
		if (this.#pruneSourceId !== null) return
		this.#pruneSourceId = GLib.timeout_add(
			GLib.PRIORITY_DEFAULT_IDLE,
			PRUNE_DELAY_MS,
			() => {
				this.#pruneSourceId = null
				this.#prune()
				return GLib.SOURCE_REMOVE
			},
		)
	}

	#prune(): void {
		const all = notificationDaemon.get_notifications()
		if (all.length <= PERSIST_TRIGGER) return

		const oldest = all
			.slice()
			.sort((left, right) => left.time - right.time)
			.slice(0, all.length - PERSIST_KEEP)
		for (const notification of oldest.slice(0, PRUNE_BUDGET))
			notification.dismiss()
		if (oldest.length > PRUNE_BUDGET) this.#schedulePrune()
	}

	vfunc_finalize(): void {
		this.#ownerWarningTimer?.cancel()
		if (this.#coalesceSourceId !== null)
			GLib.Source.remove(this.#coalesceSourceId)
		if (this.#pruneSourceId !== null) GLib.Source.remove(this.#pruneSourceId)
		for (const handler of this.#storeHandlers)
			notificationDaemon.disconnect(handler)
		this.#storeHandlers = []
		this.#unsubscribeBlacklist()
		super.vfunc_finalize()
	}
}

export const notificationManager = new NotificationManager()
