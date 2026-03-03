import app from "ags/gtk4/app"
import { Accessor, CCProps, createBinding, createComputed } from "ags"
import { idle } from "ags/time"
import { execAsync } from "ags/process"

import Apps from "gi://AstalApps"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk"
import Pango from "gi://Pango"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalNotifd from "gi://AstalNotifd"

import giCairo from "cairo"

import env from "$lib/env"
import icons from "$lib/icons"
import { attemptAsync } from "$lib/result"
import { hypr } from "$lib/services"

export { debounce } from "$lib/timing"

export type Props<T extends Gtk.Widget, Props> = CCProps<T, Partial<Props>>

type Vertical = "top" | "center" | "bottom"
type Horizontal = "left" | "center" | "right"
export type Position =
	| `${Vertical}-${Horizontal}`
	| "center"

export function popupLayout(bar: Accessor<string>, popup: Accessor<string>): Accessor<Position> {
	return createComputed(() => {
		const vertical = bar().split("-")[0]
		const horizontal = popup().split("-").pop() ?? "center"
		return `${vertical}-${horizontal}` as Position
	})
}

export function getClientTitle(c: AstalHyprland.Client) {
	const title = createBinding(c, "title")
	const className = createBinding(c, "class")
	return createComputed(() => {
		if (title()?.length) return title()
		const name = (className() || "Unknown").split(".").pop()!
		return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
	})
}

export async function wlCopy(data: string) {
	if (!dependencies("wl-copy")) return ""
	execAsync(`wl-copy "${data}"`)
}

export function toggleClass(widget: Gtk.Widget, name: string, enable?: boolean) {
	if (enable === undefined)
		enable = !widget.has_css_class(name)

	if (enable)
		widget.add_css_class(name)
	else
		widget.remove_css_class(name)
}

export function isInsideEntry(widget: Gtk.Widget | null) {
	let current: Gtk.Widget | null = widget

	while (current) {
		if (current instanceof Gtk.Entry)
			return true

		current = current.get_parent()
	}

	return false
}

export function updateLabelTooltip(label: Gtk.Label) {
	idle(() => {
		if (!label.get_visible?.())
			return

		const layout = label.get_layout?.()
		const isEllipsized = layout?.is_ellipsized?.()
			?? (layout?.get_ellipsize?.() ?? Pango.EllipsizeMode.NONE) !== Pango.EllipsizeMode.NONE
		const text = label.get_text?.() ?? ""
		label.set_tooltip_text(isEllipsized ? text : null)
	})
}

export async function notify(opts: {
	id?: number
	appName?: string
	appIcon?: string
	previewImage?: string
	actions?: Record<string, string>
	body?: string
	summary?: string
	urgency?: "low" | "normal" | "critical"
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

		hintTable["urgency"] = new GLib.Variant("y", urgency === "critical" ? 2 : urgency === "low" ? 0 : 1)

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
	const notifd = AstalNotifd.get_default()

	const attach = (notification: AstalNotifd.Notification) => {
		notification.connect("invoked", (_, actionId: string) => {
			if (actionId) execAsync(actionId).catch(() => null)
		})
	}

	const existing = notifd.get_notification(id)
	if (existing) {
		attach(existing)
		return
	}

	const sub = notifd.connect("notified", (_, notifiedId: number) => {
		if (notifiedId !== id) return
		notifd.disconnect(sub)
		const notification = notifd.get_notification(id)
		if (notification) attach(notification)
	})
}

export function toggleWindow(name: string | undefined, hide: boolean = true) {
	if (name == undefined) return
	const win = app.get_window(name)
	if (win?.visible) {
		hide ? win.hide() : win.close()
	} else {
		win?.show()
	}
}

// BUG: GTK 4.22 crashes when destroying an unmapped application window. Hide it instead;
// windows with a surface must still be destroyed so they cannot be re-anchored.
export function releaseMonitorWindow(win?: Gtk.Window | null) {
	if (!win) return
	idle(() => {
		if (win.get_application() && !win.get_surface())
			win.set_visible(false)
		else
			win.destroy()
	})
}

export function ignoreInput(widget: Gtk.Window) {
	widget.get_surface()?.set_input_region(new giCairo.Region)
}

export function onWindowToggle(name: string, callback: (w: Gtk.Window) => void) {
	app.connect("window-toggled", (_, w: Gtk.Window) => {
		if (w.name === name) {
			callback(w)
		}
	})
}

export function formatClock(length: number) {
	const hours = Math.floor(length / 3600)
	const minutes = Math.floor((length % 3600) / 60)
	const seconds = Math.floor(length % 60)

	const mm = minutes.toString().padStart(hours ? 2 : 1, "0")
	const ss = seconds.toString().padStart(2, "0")

	return hours
		? `${hours}:${mm}:${ss}`
		: `${minutes}:${ss}`
}

export function timeAgo(time: number) {
	const now = GLib.DateTime.new_now_local()
	const then = GLib.DateTime.new_from_unix_local(time)
	if (!then) return ""
	const diff = now.to_unix() - then.to_unix()
	if (diff < 60) return "now"
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
	return `${Math.floor(diff / 86400)}d ago`
}

export function range(length: number, start = 1) {
	return Array.from({ length }, (_, i) => i + start)
}

export type MaybeAccessor<T> = Accessor<T> | T

export function isAccessor<T>(value: MaybeAccessor<T>): value is Accessor<T> {
	return typeof value === "function" && "peek" in value
}

export function readValue<T>(value: MaybeAccessor<T>): T {
	return isAccessor(value) ? value.peek() : value
}

export function formatDuration(seconds: number): string {
	if (seconds === 0)
		return ""

	const days = Math.floor(seconds / (24 * 60 * 60))
	const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60))
	const minutes = Math.floor((seconds % (60 * 60)) / 60)
	const secs = seconds % 60

	const parts: string[] = []

	if (days > 0)
		parts.push(`${days}d`)

	if (hours > 0 || days > 0)
		parts.push(`${hours}h`)

	if (minutes > 0 || hours > 0 || days > 0)
		parts.push(`${minutes}m`)

	parts.push(`${secs}s`)

	return parts.join(" ")
}

export function icon(name?: string, fallback = icons.missing): string {
	if (name && env.iconTheme.peek().has_icon(name)) {
		return name
	}
	return fallback
}

const dependencyCache = new Map<string, boolean>()

export function dependencies(...bins: string[]) {
	const missing = bins.filter(bin => {
		let found = dependencyCache.get(bin)
		if (found === undefined) {
			found = GLib.find_program_in_path(bin) !== null
			dependencyCache.set(bin, found)
		}
		return !found
	})

	if (missing.length > 0) {
		console.warn(`Missing dependencies: ${missing.join(", ")}`)
		notify({ appIcon: icons.missing, appName: "Error", summary: "Missing dependencies", body: `Could not locate ${missing.join(", ")}`, urgency: "critical" })
	}

	return missing.length === 0
}

export function launchApp(app: Apps.Application | string) {
	const exe = typeof app === "string"
		? app.trim()
		: app.executable
			.split(/\s+/)
			.filter(str => !str.startsWith("%") && !str.startsWith("@"))
			.join(" ")
			.trim()

	hypr.message_async(`dispatch exec '${exe}'`, null)
}
