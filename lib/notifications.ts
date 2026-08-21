// Sends desktop notifications and runs actions for notifications created by this shell.

import { execAsync } from "ags/process"

import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import icons from "$lib/icons"
import { hasProgram } from "$lib/programs"
import { attempt, attemptAsync } from "$lib/result"

export const notificationDaemon = AstalNotifd.get_default()

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
		} = options
		const hints: Record<string, GLib.Variant> = {
			urgency: new GLib.Variant("y", URGENCY_LEVEL[urgency]),
		}
		if (previewImage) hints["image-path"] = new GLib.Variant("s", previewImage)

		const actionList: string[] = []
		for (const [label, command] of Object.entries(actions))
			if (label.trim() && command.trim()) actionList.push(command, label)

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
					hints,
					-1,
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
		if (actionList.length) wireNotificationActions(notificationId)
		return notificationId
	})
	if (!result.ok) {
		console.error("notifications.send: Failed to send notification", result.err)
		return undefined
	}
	return result.value
}

export function notifyMissingPrograms(...bins: string[]): boolean {
	const missing = bins.filter((bin) => !hasProgram(bin))
	if (missing.length === 0) return true

	console.warn(`Missing dependencies: ${missing.join(", ")}`)
	void notify({
		appIcon: icons.missing,
		appName: "Error",
		summary: "Missing dependencies",
		body: `Could not locate ${missing.join(", ")}`,
		urgency: "critical",
	})
	return false
}

function wireNotificationActions(id: number): void {
	const attach = (notification: AstalNotifd.Notification) => {
		notification.connect("invoked", (_notification, actionId: string) => {
			if (actionId)
				execAsync(actionId).catch((error) =>
					console.error(
						`notifications.action: Failed to run ${actionId}`,
						error,
					),
				)
		})
	}

	const existing = notificationDaemon.get_notification(id)
	if (existing) return attach(existing)

	const handler = notificationDaemon.connect(
		"notified",
		(_daemon, notifiedId: number) => {
			if (notifiedId !== id) return
			const result = attempt(() => {
				notificationDaemon.disconnect(handler)
				const notification = notificationDaemon.get_notification(id)
				if (notification) attach(notification)
			})
			if (!result.ok)
				console.error(
					`notifications.action: Failed to watch notification ${id}`,
					result.err,
				)
		},
	)
}
