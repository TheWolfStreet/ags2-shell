import { createState } from "ags"
import { execAsync } from "ags/process"
import app from "$lib/app"
import { timeout, type Timer } from "$lib/time"

import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import icons from "$lib/icons"
import { attempt, attempt_async, type Result } from "$lib/result"

export const notification_daemon = AstalNotifd.get_default()

type NotificationUrgency = "low" | "normal" | "critical"
type NotificationAction = { label: string; argv: string[] }

const URGENCY_LEVEL: Record<NotificationUrgency, number> = {
	low: 0,
	normal: 1,
	critical: 2,
}
const DBUS_TIMEOUT_MS = 5000
const ATTACH_TIMEOUT_MS = 2000
const OWN_ACTION_PREFIX = "ags2-shell:"

const active = new Map<number, () => void>()
const bound_keys = new Set<string>()
const [bound_revision, set_bound_revision] = createState(0)
let shutting_down = false
app.connect("shutdown", () => {
	shutting_down = true
	for (const cleanup of [...active.values()]) cleanup()
})

function call_notification_bus(
	destination: string,
	method: string,
	args: GLib.Variant,
	reply_type: string,
) {
	return new Promise<GLib.Variant>((resolve, reject) => {
		Gio.DBus.session.call(
			destination,
			method === "GetNameOwner"
				? "/org/freedesktop/DBus"
				: "/org/freedesktop/Notifications",
			method === "GetNameOwner"
				? "org.freedesktop.DBus"
				: "org.freedesktop.Notifications",
			method,
			args,
			new GLib.VariantType(reply_type),
			Gio.DBusCallFlags.NONE,
			DBUS_TIMEOUT_MS,
			null,
			(connection, result) => {
				try {
					resolve(connection!.call_finish(result))
				} catch (error) {
					reject(error)
				}
			},
		)
	})
}

function watch_actions(
	id: number,
	actions: Map<string, NotificationAction>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let notification: AstalNotifd.Notification | null = null
		let invoked_handler = 0
		let notified_handler = 0
		let resolved_handler = 0
		let pending_timer: Timer | null = null
		let settled = false
		let closed = false
		let invoked = false

		const cleanup = (reason?: unknown) => {
			if (closed) return
			closed = true
			if (notification) {
				for (const key of actions.keys()) bound_keys.delete(key)
				set_bound_revision((revision) => revision + 1)
			}
			pending_timer?.cancel()
			pending_timer = null
			if (notified_handler) notification_daemon.disconnect(notified_handler)
			if (resolved_handler) notification_daemon.disconnect(resolved_handler)
			if (notification && invoked_handler)
				notification.disconnect(invoked_handler)
			if (!settled) {
				settled = true
				reject(
					new Error(
						`Notification ${id} was removed before its actions were ready`,
						{ cause: reason },
					),
				)
			}
			if (active.get(id) === cleanup) active.delete(id)
		}
		active.get(id)?.()
		active.set(id, cleanup)

		const attach = () => {
			if (closed || notification) return
			const result = attempt(() => {
				const current = notification_daemon.get_notification(id)
				if (!current) return
				const received = current.get_actions()
				if (
					received.length !== actions.size ||
					received.some(
						(action) => actions.get(action.id)?.label !== action.label,
					)
				) {
					cleanup(new Error("Notification actions did not match the sent keys"))
					return
				}
				notification = current
				for (const key of actions.keys()) bound_keys.add(key)
				set_bound_revision((revision) => revision + 1)
				invoked_handler = current.connect(
					"invoked",
					(_notification, action_id: string) => {
						if (
							active.get(id) !== cleanup ||
							notification_daemon.get_notification(id) !== current
						)
							return
						const action = actions.get(action_id)
						if (!action || invoked) return
						invoked = true
						const launched = attempt(() => execAsync(action.argv))
						if (launched.ok)
							void launched.value.catch((error) =>
								console.error(
									`notifications.action: Failed to run ${action.label}`,
									error,
								),
							)
						else
							console.error(
								`notifications.action: Failed to run ${action.label}`,
								launched.err,
							)
						const dismissed = attempt(() => current.dismiss())
						if (!dismissed.ok)
							console.error(
								"notifications.action: Failed to dismiss notification",
								dismissed.err,
							)
						cleanup()
					},
				)
				pending_timer?.cancel()
				pending_timer = null
				settled = true
				resolve()
			})
			if (!result.ok) cleanup(result.err)
		}

		notified_handler = notification_daemon.connect(
			"notified",
			(_daemon, notified_id: number) => {
				if (notified_id !== id) return
				if (notification) cleanup()
				else attach()
			},
		)
		resolved_handler = notification_daemon.connect(
			"resolved",
			(_daemon, resolved_id: number) => {
				if (resolved_id === id) cleanup()
			},
		)
		pending_timer = timeout(ATTACH_TIMEOUT_MS, () => {
			pending_timer = null
			cleanup()
		})
		attach()
	})
}

export function notification_action_available(key: string): boolean {
	bound_revision()
	return !key.startsWith(OWN_ACTION_PREFIX) || bound_keys.has(key)
}

export async function notify(options: {
	id?: number
	app_name?: string
	app_icon?: string
	preview_image?: string
	actions?: NotificationAction[]
	body?: string
	summary?: string
	urgency?: NotificationUrgency
}): Promise<Result<number>> {
	return attempt_async(async () => {
		if (shutting_down) throw new Error("Notification service is shutting down")
		const {
			id,
			app_name = "",
			app_icon = "",
			preview_image = "",
			actions = [],
			body = "",
			summary = "",
			urgency = "normal",
		} = options
		const name = "org.freedesktop.Notifications"
		let destination = name
		if (actions.length) {
			const owner = await call_notification_bus(
				"org.freedesktop.DBus",
				"GetNameOwner",
				new GLib.Variant("(s)", [name]),
				"(s)",
			)
			const [unique_name] = owner.recursiveUnpack() as [string]
			if (unique_name !== Gio.DBus.session.get_unique_name())
				throw new Error("This shell does not own the notification service")
			destination = unique_name
		}

		const hints: Record<string, GLib.Variant> = {
			urgency: new GLib.Variant("y", URGENCY_LEVEL[urgency]),
		}
		if (preview_image)
			hints["image-path"] = new GLib.Variant("s", preview_image)
		if (actions.length) {
			hints.resident = new GLib.Variant("b", true)
		}

		const allowed = new Map<string, NotificationAction>()
		const action_list: string[] = []
		for (const action of actions) {
			if (!action.label.trim() || !action.argv.length || !action.argv[0])
				throw new Error("Notification actions require a label and a program")
			const key = `${OWN_ACTION_PREFIX}${GLib.uuid_string_random()}`
			allowed.set(key, { label: action.label, argv: [...action.argv] })
			action_list.push(key, action.label)
		}

		const reply = await call_notification_bus(
			destination,
			"Notify",
			new GLib.Variant("(susssasa{sv}i)", [
				app_name,
				id ?? 0,
				app_icon,
				summary,
				body,
				action_list,
				hints,
				-1,
			]),
			"(u)",
		)
		const [notification_id] = reply.recursiveUnpack() as [number]
		if (shutting_down)
			throw new Error(
				"Notification service shut down before actions were ready",
			)
		if (allowed.size) await watch_actions(notification_id, allowed)
		return notification_id
	})
}

export function notify_missing_programs(...bins: string[]): boolean {
	const missing = bins.filter((bin) => GLib.find_program_in_path(bin) === null)
	if (missing.length === 0) return true

	console.warn(`Missing dependencies: ${missing.join(", ")}`)
	void notify({
		app_icon: icons.missing,
		app_name: "Error",
		summary: "Missing dependencies",
		body: `Could not locate ${missing.join(", ")}`,
		urgency: "critical",
	}).then((result) => {
		if (!result.ok)
			console.error(
				"notifications.send: Failed to send notification",
				result.err,
			)
	})
	return false
}
