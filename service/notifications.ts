// Lists notifications, joins duplicates, removes old ones, and handles dismissal.

import GObject, { getter, register } from "ags/gobject"
import { execAsync } from "ags/process"
import { Timer, timeout } from "ags/time"

import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import icons from "$lib/icons"
import { hasProgram } from "$lib/programs"
import { attempt, attemptAsync } from "$lib/result"
import { notificationDaemon } from "$service/astal"
import options from "$shell/options"

const DISPLAY_LIMIT = 50
const PERSIST_KEEP = 50
const PERSIST_TRIGGER = 75
const PRUNE_BUDGET = 8
const COALESCE_MS = 16
const PRUNE_DELAY_MS = 250

type NotificationUrgency = "low" | "normal" | "critical"

const URGENCY_LEVEL: Record<NotificationUrgency, number> = {
	low: 0,
	normal: 1,
	critical: 2,
}

export async function notify(options: {
	id?: number
	appName?: string
	appIcon?: string
	previewImage?: string
	actions?: Record<string, string>
	body?: string
	summary?: string
	urgency?: NotificationUrgency
	timeout?: number
	hints?: Record<string, string>
}) {
	const result = await attemptAsync(async () => {
		const {
			id,
			appName = "",
			appIcon = "",
			previewImage = "",
			actions = {},
			body = "",
			summary = "",
			urgency = "normal",
			timeout,
			hints = {},
		} = options

		const toHintVariant = (type: string, rawValue: string): GLib.Variant => {
			switch (type) {
				case "boolean":
					return new GLib.Variant("b", rawValue === "1" || rawValue.toLowerCase() === "true")
				case "int": {
					const parsed = Number.parseInt(rawValue, 10)
					return new GLib.Variant("i", Number.isFinite(parsed) ? parsed : 0)
				}
				case "double": {
					const parsed = Number.parseFloat(rawValue)
					return new GLib.Variant("d", Number.isFinite(parsed) ? parsed : 0)
				}
				case "byte": {
					const parsed = Number.parseInt(rawValue, 10)
					const bounded = Number.isFinite(parsed) ? Math.max(0, Math.min(255, parsed)) : 0
					return new GLib.Variant("y", bounded)
				}
				case "string":
				default:
					return new GLib.Variant("s", rawValue)
			}
		}

		const hintTable: Record<string, GLib.Variant> = {}
		for (const [key, value] of Object.entries(hints)) {
			if (!key) continue

			const split = key.split(":")
			if (split.length >= 2) {
				const type = split.shift() || "string"
				hintTable[split.join(":")] = toHintVariant(type, value)
			} else {
				hintTable[key] = new GLib.Variant("s", value)
			}
		}

		if (previewImage)
			hintTable["image-path"] = new GLib.Variant("s", previewImage)

		hintTable["urgency"] = new GLib.Variant("y", URGENCY_LEVEL[urgency])

		const actionList: string[] = []
		for (const [actionLabel, actionCommand] of Object.entries(actions)) {
			if (!actionLabel.trim() || !actionCommand.trim())
				continue
			actionList.push(actionCommand, actionLabel)
		}

		const reply = await new Promise<GLib.Variant>((resolve, reject) => {
			Gio.DBus.session.call(
				"org.freedesktop.Notifications",
				"/org/freedesktop/Notifications",
				"org.freedesktop.Notifications",
				"Notify",
				new GLib.Variant("(susssasa{sv}i)", [
					appName,
					id ?? 0,
					appIcon,
					summary,
					body,
					actionList,
					hintTable,
					timeout ?? -1,
				]),
				new GLib.VariantType("(u)"),
				Gio.DBusCallFlags.NONE,
				-1,
				null,
				(connection, callResult) => {
					try {
						resolve(connection!.call_finish(callResult))
					} catch (error) {
						reject(error)
					}
				},
			)
		})

		const [notificationId] = reply.recursiveUnpack() as [number]
		if (actionList.length)
			wireNotificationActions(notificationId)

		return notificationId
	})
	if (!result.ok) {
		console.error("notifications.send: Failed to send notification", result.err)
		return undefined
	}
	return result.value
}

export function notifyMissingPrograms(...bins: string[]) {
	const missing = bins.filter(bin => !hasProgram(bin))

	if (missing.length > 0) {
		console.warn(`Missing dependencies: ${missing.join(", ")}`)
		notify({ appIcon: icons.missing, appName: "Error", summary: "Missing dependencies", body: `Could not locate ${missing.join(", ")}`, urgency: "critical" })
	}

	return missing.length === 0
}

function wireNotificationActions(id: number) {
	const attach = (notification: AstalNotifd.Notification) => {
		notification.connect("invoked", (_, actionId: string) => {
			if (actionId)
				execAsync(actionId).catch(error => console.error(`notifications.action: Failed to run ${actionId}`, error))
		})
	}

	const existing = notificationDaemon.get_notification(id)
	if (existing) {
		attach(existing)
		return
	}

	const handler = notificationDaemon.connect("notified", (_, notifiedId: number) => {
		if (notifiedId !== id) return
		const result = attempt(() => {
			notificationDaemon.disconnect(handler)
			const notification = notificationDaemon.get_notification(id)
			if (notification) attach(notification)
		})
		if (!result.ok)
			console.error(`notifications.action: Failed to watch notification ${id}`, result.err)
	})
}

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

	readonly sessionStart: number

	constructor() {
		super()

		this.#notifd = notificationDaemon
		this.#storeHandlers = []
		this.#coalesceSourceId = null
		this.#pruneSourceId = null
		this.#ownerWarningTimer = null
		this.sessionStart = Math.floor(Date.now() / 1000)

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
		return this.#notifd.get_notifications()
			.filter(n => !this.isBlacklisted(n))
			.sort((a, b) => b.time - a.time)
			.slice(0, DISPLAY_LIMIT)
	}

	isBlacklisted(notification: AstalNotifd.Notification): boolean {
		const app = notification.get_app_name() || notification.get_desktop_entry()
		return (options.notifications.blacklist.peek() || []).includes(app)
	}

	dismissAllImmediately() {
		for (const n of this.#notifd.get_notifications())
			n.dismiss()
	}

	get doNotDisturb(): boolean {
		return this.#notifd.get_dont_disturb()
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
