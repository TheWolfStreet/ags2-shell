// Lists notifications, joins duplicates, removes old ones, and handles dismissal.

import GObject, { getter, property, register } from "ags/gobject"
import { Timer, timeout } from "ags/time"

import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt } from "$lib/result"
import { notificationDaemon } from "$service/system"
import options from "options"

const DISPLAY_LIMIT = 50
const PERSIST_KEEP = 50
const PERSIST_TRIGGER = 75
const PRUNE_BUDGET = 8
const COALESCE_MS = 16
const PRUNE_DELAY_MS = 250

@register()
class NotificationManager extends GObject.Object {
	declare static $gtype: GObject.GType<NotificationManager>
	static instance: NotificationManager

	static get_default(): NotificationManager {
		return this.instance ??= new NotificationManager()
	}

	#notifd: AstalNotifd.Notifd
	#storeHandlers: number[]
	#coalesceSourceId: number | null
	#pruneSourceId: number | null
	#ownerWarningTimer: Timer | null
	#dismissAllTimer: Timer | null

	readonly sessionStart: number

	@property(Boolean) dismissingAll: boolean
	@property(Boolean) popupHovered: boolean

	constructor() {
		super()

		this.#notifd = notificationDaemon
		this.#storeHandlers = []
		this.#coalesceSourceId = null
		this.#pruneSourceId = null
		this.#ownerWarningTimer = null
		this.#dismissAllTimer = null
		this.sessionStart = Math.floor(Date.now() / 1000)
		this.dismissingAll = false
		this.popupHovered = false

		this.#storeHandlers.push(
			this.#notifd.connect("notified", () => this.#onStoreChanged()),
			this.#notifd.connect("resolved", () => this.#onStoreChanged()),
		)

		this.#schedulePrune()
		this.#ownerWarningTimer = timeout(5000, () => {
			this.#ownerWarningTimer = null
			this.#warnIfNotDaemonOwner()
		})
	}

	#warnIfNotDaemonOwner() {
		const result = attempt(() => {
			const conn = Gio.DBus.session
			const reply = conn.call_sync(
				"org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
				"GetNameOwner", GLib.Variant.new_tuple([GLib.Variant.new_string("org.freedesktop.Notifications")]),
				new GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 1000, null,
			)
			const [owner] = reply.recursiveUnpack() as [string]
			if (owner !== conn.get_unique_name())
				console.warn(`notifications: org.freedesktop.Notifications is owned by ${owner}, not this shell (${conn.get_unique_name()}) — a squatting process will steal notifications and desync the list`)
		})
		if (!result.ok)
			console.debug("notifications: could not verify daemon bus ownership", result.err)
	}

	#onStoreChanged() {
		this.#schedulePrune()

		if (this.#coalesceSourceId !== null)
			return

		this.#coalesceSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COALESCE_MS, () => {
			this.#coalesceSourceId = null
			this.notify("notifications")
			return GLib.SOURCE_REMOVE
		})
	}

	@getter(Array)
	get notifications(): Array<AstalNotifd.Notification> {
		const blacklist = options.notifications.blacklist.peek() || []
		return this.#notifd.get_notifications()
			.filter(n => !blacklist.includes(n.get_app_name() || n.get_desktop_entry()))
			.sort((a, b) => b.time - a.time)
			.slice(0, DISPLAY_LIMIT)
	}

	clearAll() {
		for (const n of this.#notifd.get_notifications())
			n.dismiss()
	}

	dismissAll(transitionDuration: number, maxStaggerDelay: number) {
		this.dismissingAll = true
		this.#dismissAllTimer?.cancel()
		this.#dismissAllTimer = timeout(transitionDuration + maxStaggerDelay, () => {
			this.#dismissAllTimer = null
			this.dismissingAll = false
			this.clearAll()
		})
	}

	get dontDisturb(): boolean {
		return this.#notifd.get_dont_disturb()
	}

	set dontDisturb(value: boolean) {
		this.#notifd.set_dont_disturb(value)
	}

	#schedulePrune() {
		if (this.#pruneSourceId !== null)
			return

		this.#pruneSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, PRUNE_DELAY_MS, () => {
			this.#pruneSourceId = null
			this.#prune()
			return GLib.SOURCE_REMOVE
		})
	}

	#prune() {
		const all = this.#notifd.get_notifications()
		if (all.length <= PERSIST_TRIGGER)
			return

		const oldest = all.slice().sort((a, b) => a.time - b.time).slice(0, all.length - PERSIST_KEEP)
		for (const n of oldest.slice(0, PRUNE_BUDGET))
			n.dismiss()

		if (oldest.length > PRUNE_BUDGET)
			this.#schedulePrune()
	}

	vfunc_finalize() {
		this.#ownerWarningTimer?.cancel()
		this.#ownerWarningTimer = null
		this.#dismissAllTimer?.cancel()
		this.#dismissAllTimer = null
		if (this.#coalesceSourceId !== null) {
			GLib.Source.remove(this.#coalesceSourceId)
			this.#coalesceSourceId = null
		}

		if (this.#pruneSourceId !== null) {
			GLib.Source.remove(this.#pruneSourceId)
			this.#pruneSourceId = null
		}

		for (const handler of this.#storeHandlers)
			this.#notifd.disconnect(handler)
		this.#storeHandlers = []

		super.vfunc_finalize()
	}
}

export const notificationManager = NotificationManager.get_default()
