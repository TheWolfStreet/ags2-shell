import app from "ags/gtk4/app"
import { CCProps } from "ags"
import { exec, execAsync } from "ags/process"

import Apps from "gi://AstalApps"
import Notifd from "gi://AstalNotifd"
import Gtk from "gi://Gtk"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

import icons, { substitutes } from "./icons"
import options from "../options"
import { hypr, notifd } from "$lib/services"
import { Opt } from "./option"
import { Gdk } from "ags/gtk4"

export type Props<T extends Gtk.Widget, Props> = CCProps<T, Partial<Props>>

export function toggleClass(widget: Gtk.Widget, name: string, enable?: boolean) {
	if (enable === undefined)
		enable = !widget.has_css_class(name)

	if (enable)
		widget.add_css_class(name)
	else
		widget.remove_css_class(name)
}

export function duration(length: number) {
	const hours = Math.floor(length / 3600);
	const min = Math.floor((length % 3600) / 60);
	const sec = Math.floor(length % 60);
	const sec0 = sec < 10 ? "0" : "";

	return hours
		? `${hours}:${min < 10 ? "0" : ""}${min}:${sec0}${sec}`
		: `${min}:${sec0}${sec}`;
}

export async function notify({
	id,
	appName = "",
	appIcon = "",
	// attachedImage = "",
	actions = {},
	body = "",
	summary = "",
	urgency = "normal",
	timeout,
	hints = {},
}: {
	id?: number
	appName?: string
	appIcon?: string
	actions?: Record<string, string>
	body?: string
	summary?: string
	urgency?: "low" | "normal" | "critical"
	timeout?: number
	hints?: Record<string, string>
}) {
	try {
		const args = []

		if (id !== undefined) args.push(`-r ${id}`)
		if (appName) args.push(`-a "${appName}"`)
		if (appIcon) args.push(`-i "${appIcon}"`)
		if (urgency) args.push(`-u ${urgency}`)
		if (timeout) args.push(`-t ${timeout}`)
		if (hints) {
			Object.entries(hints).forEach(([key, value]) => {
				args.push(`-h ${key}:${value}`)
			})
		}
		if (summary) args.push(`"${summary}"`)
		if (body) args.push(`"${body}"`)

		if (Object.keys(actions).length > 0) {
			Object.entries(actions).forEach(([actionName, actionText]) => {
				args.push(`-A "${actionText}=${actionName}"`)
			})
		}

		const result = await execAsync(`notify-send -p ${args.join(" ")}`)
		const retId = Number(result.split('\n')[0])
		if (Object.keys(actions).length > 0) {
			execAsync(result.split('\n')[1])
		}
		return retId
	} catch (error) {
		logError(error)
		throw error
	}
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

export function onWindowToggle(name: string, callback: (w: Gtk.Window) => void) {
	app.connect("window-toggled", (_: any, w: Gtk.Window) => {
		if (w.name === name) {
			callback(w);
		}
	});
}


export function checkDefault(opts: Opt<any>[]) {
	return opts.some(opt => {
		try {
			return JSON.stringify(opt.get()) !== JSON.stringify(opt.get_default())
		} catch {
			return opt.get() !== opt.get_default()
		}
	})
}

export function range(length: number, start = 1) {
	return Array.from({ length }, (_, i) => i + start)
}

export function lookupIcon(name: string, size = 16) {
	if (!name) return null;

	const display = Gdk.Display.get_default();
	if (!display) return null;

	const iconTheme = Gtk.IconTheme.get_for_display(display);
	const textDir = Gtk.Widget.get_default_direction();

	const monitors = display.get_monitors();
	const n_monitors = monitors.get_n_items();
	const monitor = n_monitors > 0 ? monitors.get_item(0) as Gdk.Monitor : null;
	const scale = monitor ? monitor.get_scale_factor() : 1;
	const icon = Gio.ThemedIcon.new(name);

	const info = iconTheme.lookup_by_gicon(
		icon,
		size,
		Gtk.IconLookupFlags.FORCE_SYMBOLIC,
		textDir,
		scale
	);

	return info.get_icon_name()
}

export function ensurePath(path: string) {
	if (!GLib.file_test(path, GLib.FileTest.EXISTS))
		Gio.File.new_for_path(path).make_directory_with_parents(null)
}

export function icon(name: string | null, fallback = icons.missing): string {
	if (!name)
		return fallback || ""

	if (GLib.file_test(name, GLib.FileTest.EXISTS))
		return name

	// @ts-ignore: Valid keys
	const resolved = substitutes[name] || name
	const found = lookupIcon(resolved)
	return found || fallback
}

export function dependencies(...bins: string[]) {
	const missing: string[] = []

	bins.forEach(bin => {
		try {
			exec(`which ${bin}`)
		} catch (error) {
			missing.push(bin)
		}
	})

	if (missing.length > 0) {
		console.warn(`Missing dependencies: ${missing.join(", ")}`)
		notify({ appIcon: icons.missing, appName: "Error", summary: "Missing dependencies", body: `Could not locate ${missing.join(", ")}`, urgency: "critical" })
	}

	return missing.length === 0
}

export async function bash(strings: TemplateStringsArray | string, ...values: unknown[]) {
	const cmd = typeof strings === "string" ? strings : strings
		.flatMap((str, i) => str + `${values[i] ?? ""}`)
		.join("")
	return execAsync(["bash", "-c", cmd]).catch(err => {
		console.error(cmd, err)
		return ""
	})
}

export function bashSync(strings: TemplateStringsArray | string, ...values: unknown[]) {
	const cmd = typeof strings === "string" ? strings : strings
		.flatMap((str, i) => str + `${values[i] ?? ""}`)
		.join("")
	try {
		return exec(["bash", "-c", cmd])
	} catch {
		return ""
	}
}

export async function sh(cmd: string | string[]) {
	return execAsync(cmd).catch((err: any) => {
		console.error(typeof cmd === "string" ? cmd : cmd.join(" "), err)
		return ""
	})
}

export function launchApp(app: Apps.Application | string) {
	const exe = typeof app === "string"
		? app
		: app.executable
			.split(/\s+/)
			.filter(str => !str.startsWith("%") && !str.startsWith("@"))
			.join(" ")

	if (typeof app !== "string") {
		app.frequency += 1
	}

	hypr.message_async(`dispatch exec ${exe}`, null)
}

export function notificationBlacklisted(input?: number | Notifd.Notification): boolean {
	const notif = typeof input === "number"
		? notifd.get_notification(input)
		: input

	if (!notif) return false

	const blacklist = options.notifications.blacklist.get()
	const name = notif.appName || notif.desktopEntry

	return blacklist.includes(name)
}
