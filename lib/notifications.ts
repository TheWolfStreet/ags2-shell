import { createState } from "ags"
import { execAsync } from "ags/process"
import app from "$lib/app"
import { timeout } from "$lib/time"

import AstalNotifd from "gi://AstalNotifd"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import icons from "$lib/icons"
import {
	attempt,
	attempt_async,
	err,
	log_error,
	ok,
	type result,
} from "$lib/result"

export const notification_daemon = AstalNotifd.get_default()

type notification_urgency = "low" | "normal" | "critical"
type notification_action = { label: string; argv: string[] }
type bus_target = { name: string; path: string; iface: string }

const urgency_level: Record<notification_urgency, number> = {
	low: 0,
	normal: 1,
	critical: 2,
}
const dbus_timeout_ms = 5000
const attach_timeout_ms = 2000
const own_action_prefix = "ags2-shell:"

const notification_service: bus_target = {
	name: "org.freedesktop.Notifications",
	path: "/org/freedesktop/Notifications",
	iface: "org.freedesktop.Notifications",
}
const bus_daemon: bus_target = {
	name: "org.freedesktop.DBus",
	path: "/org/freedesktop/DBus",
	iface: "org.freedesktop.DBus",
}

const active = new Map<number, () => void>()
const bound_keys = new Set<string>()
const [bound_revision, set_bound_revision] = createState(0)
let shutting_down = false
app.connect("shutdown", () => {
	shutting_down = true
	for (const cleanup of [...active.values()]) cleanup()
})

async function call_bus(
	target: bus_target,
	method: string,
	args: GLib.Variant,
	reply_type: string,
): Promise<result<GLib.Variant>> {
	const session = attempt(() => Gio.DBus.session)
	if (!session.ok) return session
	return new Promise((resolve) => {
		const started = attempt(() =>
			session.value.call(
				target.name,
				target.path,
				target.iface,
				method,
				args,
				new GLib.VariantType(reply_type),
				Gio.DBusCallFlags.NONE,
				dbus_timeout_ms,
				null,
				(connection, response) =>
					resolve(attempt(() => connection!.call_finish(response))),
			),
		)
		if (!started.ok) resolve(started)
	})
}

export async function notification_name_owner(): Promise<result<string>> {
	const owner = await call_bus(
		bus_daemon,
		"GetNameOwner",
		new GLib.Variant("(s)", [notification_service.name]),
		"(s)",
	)
	if (!owner.ok) return owner
	return ok((owner.value.recursiveUnpack() as [string])[0])
}

function same_actions(
	received: AstalNotifd.Action[],
	sent: Map<string, notification_action>,
): boolean {
	if (received.length !== sent.size) return false
	return received.every((action) => sent.get(action.id)?.label === action.label)
}

function run_action(
	action: notification_action,
	notification: AstalNotifd.Notification,
) {
	void attempt_async(() => execAsync(action.argv)).then((ran) =>
		log_error(ran, `notifications.action: Failed to run ${action.label}`),
	)
	log_error(
		attempt(() => notification.dismiss()),
		"notifications.action: Failed to dismiss notification",
	)
}

function watch_actions(
	id: number,
	actions: Map<string, notification_action>,
): Promise<result<void>> {
	return new Promise((settle) => {
		const disconnects: (() => void)[] = []
		let notification: AstalNotifd.Notification | null = null
		let settled = false

		const stop = (reason?: unknown) => {
			if (active.get(id) !== stop) return
			active.delete(id)
			timer.cancel()
			for (const disconnect of disconnects) disconnect()
			if (notification) {
				for (const key of actions.keys()) bound_keys.delete(key)
				set_bound_revision((revision) => revision + 1)
			}
			if (settled) return
			settled = true
			settle(
				err(
					new Error(
						`Notification ${id} was removed before its actions were ready`,
						{
							cause: reason,
						},
					),
				),
			)
		}

		const invoke = (current: AstalNotifd.Notification, action_id: string) => {
			const action = actions.get(action_id)
			if (!action) return
			if (notification_daemon.get_notification(id) !== current) return
			stop()
			run_action(action, current)
		}

		const bind = () => {
			if (notification) return
			const current = notification_daemon.get_notification(id)
			if (!current) return
			if (!same_actions(current.get_actions(), actions)) {
				stop(new Error("Notification actions did not match the sent keys"))
				return
			}
			notification = current
			for (const key of actions.keys()) bound_keys.add(key)
			set_bound_revision((revision) => revision + 1)
			const invoked = current.connect("invoked", (_source, action_id: string) =>
				invoke(current, action_id),
			)
			disconnects.push(() => current.disconnect(invoked))
			timer.cancel()
			settled = true
			settle(ok(undefined))
		}

		const notified = notification_daemon.connect(
			"notified",
			(_daemon, notified_id: number) => {
				if (notified_id !== id) return
				if (notification) stop()
				else bind()
			},
		)
		const resolved = notification_daemon.connect(
			"resolved",
			(_daemon, resolved_id: number) => {
				if (resolved_id === id) stop()
			},
		)
		disconnects.push(
			() => notification_daemon.disconnect(notified),
			() => notification_daemon.disconnect(resolved),
		)

		active.get(id)?.()
		active.set(id, stop)
		const timer = timeout(attach_timeout_ms, stop)
		bind()
	})
}

export function notification_action_available(key: string): boolean {
	bound_revision()
	return !key.startsWith(own_action_prefix) || bound_keys.has(key)
}

async function notify_destination(
	has_actions: boolean,
): Promise<result<bus_target>> {
	if (!has_actions) return ok(notification_service)
	const owner = await notification_name_owner()
	if (!owner.ok) return owner
	if (owner.value !== Gio.DBus.session.get_unique_name())
		return err(new Error("This shell does not own the notification service"))
	return ok({ ...notification_service, name: owner.value })
}

function notification_hints(
	urgency: notification_urgency,
	preview_image: string,
	resident: boolean,
): Record<string, GLib.Variant> {
	const hints: Record<string, GLib.Variant> = {
		urgency: new GLib.Variant("y", urgency_level[urgency]),
	}
	if (preview_image) hints["image-path"] = new GLib.Variant("s", preview_image)
	if (resident) hints.resident = new GLib.Variant("b", true)
	return hints
}

function bind_action_keys(
	actions: notification_action[],
): result<Map<string, notification_action>> {
	const allowed = new Map<string, notification_action>()
	for (const action of actions) {
		if (!action.label.trim() || !action.argv.length || !action.argv[0])
			return err(
				new Error("Notification actions require a label and a program"),
			)
		const key = `${own_action_prefix}${GLib.uuid_string_random()}`
		allowed.set(key, { label: action.label, argv: [...action.argv] })
	}
	return ok(allowed)
}

export async function notify(options: {
	id?: number
	app_name?: string
	app_icon?: string
	preview_image?: string
	actions?: notification_action[]
	body?: string
	summary?: string
	urgency?: notification_urgency
}): Promise<result<number>> {
	if (shutting_down)
		return err(new Error("Notification service is shutting down"))
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
	const has_actions = actions.length > 0
	const destination = await notify_destination(has_actions)
	if (!destination.ok) return destination
	const hints = notification_hints(urgency, preview_image, has_actions)
	const bound = bind_action_keys(actions)
	if (!bound.ok) return bound
	const allowed = bound.value
	const action_list = [...allowed].flatMap(([key, action]) => [
		key,
		action.label,
	])

	const reply = await call_bus(
		destination.value,
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
	if (!reply.ok) return reply
	const [notification_id] = reply.value.recursiveUnpack() as [number]
	if (shutting_down)
		return err(
			new Error("Notification service shut down before actions were ready"),
		)
	if (allowed.size === 0) return ok(notification_id)
	const watched = await watch_actions(notification_id, allowed)
	if (!watched.ok) return watched
	return ok(notification_id)
}

export function notify_missing_programs(...bins: string[]): boolean {
	const missing = bins.filter((bin) => GLib.find_program_in_path(bin) === null)
	if (missing.length === 0) return true

	const names = missing.join(", ")
	console.warn(`notifications.dependencies: Missing ${names}`)
	void notify({
		app_icon: icons.missing,
		app_name: "Error",
		summary: "Missing dependencies",
		body: `Could not locate ${names}`,
		urgency: "critical",
	}).then((sent) =>
		log_error(sent, "notifications.send: Failed to send notification"),
	)
	return false
}
