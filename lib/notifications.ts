// Sends desktop notifications and runs commands when their actions are clicked.

import { execAsync } from "ags/process"

import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attemptAsync } from "$lib/result"
import { notificationDaemon } from "$service/system"

type NotificationUrgency = "low" | "normal" | "critical"

const URGENCY_LEVEL: Record<NotificationUrgency, number> = {
	low: 0,
	normal: 1,
	critical: 2,
}

export async function notify(opts: {
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
		} = opts

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
				(conn, result) => {
					try {
						resolve(conn!.call_finish(result))
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
		console.error("notify: Failed to send notification", result.err)
		return undefined
	}
	return result.value
}

function wireNotificationActions(id: number) {
	const attach = (notification: AstalNotifd.Notification) => {
		notification.connect("invoked", (_, actionId: string) => {
			if (actionId) execAsync(actionId).catch(() => null)
		})
	}

	const existing = notificationDaemon.get_notification(id)
	if (existing) {
		attach(existing)
		return
	}

	const sub = notificationDaemon.connect("notified", (_, notifiedId: number) => {
		if (notifiedId !== id) return
		notificationDaemon.disconnect(sub)
		const notification = notificationDaemon.get_notification(id)
		if (notification) attach(notification)
	})
}
