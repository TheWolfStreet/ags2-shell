import Apps from "gi://AstalApps"
import Notifd from "gi://AstalNotifd"
import { exec, execAsync, Variable, Gio, GLib } from "astal"
import { App, Gtk } from "astal/gtk3"
import { Subscribable, Connectable } from "astal/binding"

import icons, { substitutes } from "./icons"
import { Opt } from "./option"
import { hypr, notifd } from "./services"
import options from "../options"

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
	attachedImage = "",
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

export function toggleWindow(name: string, hide?: boolean) {
	const win = App.get_window(name)
	if (win?.visible) {
		hide ? win.hide() : win.close()
	} else {
		win?.show()
	}
}

export function onWindowToggle(self: any, name: string, callback: (w: Gtk.Window) => void) {
	self.hook(App, "window-toggled", (_: any, w: Gtk.Window) => {
		if (w.name == name) {
			callback(w)
		}
	})
}

export function initHook(
	self: any,
	object: Connectable,
	signal: string,
	callback: (...args: any[]) => void
): void

export function initHook(
	self: any,
	object: Subscribable,
	callback: (...args: any[]) => void
): void

export function initHook(
	self: any,
	object: Connectable | Subscribable,
	signalOrCallback: string | ((...args: any[]) => void),
	callback?: (...args: any[]) => void
): void {
	if ('hook' in self && typeof signalOrCallback === 'string' && callback) {
		callback()
		self.hook(object, signalOrCallback, callback)
	} else if ('hook' in self && typeof signalOrCallback === 'function') {
		signalOrCallback()
		self.hook(object, signalOrCallback)
	} else {
		throw new Error('Invalid arguments')
	}
}

export function checkDefault(opts: Opt[]) {
	const changes = opts.map((opt) => {
		return Variable.derive([opt], (value) => value !== opt.initial)
	})

	const any_changed = Variable.derive(changes, (...change_flags) => change_flags.some(changed => changed))

	return any_changed()
}

export function range(length: number, start = 1) {
	return Array.from({ length }, (_, i) => i + start)
}

export function lookUpIcon(name?: string, size = 16) {
	if (!name)
		return null

	return Gtk.IconTheme.get_default().lookup_icon(
		name,
		size,
		Gtk.IconLookupFlags.USE_BUILTIN,
	)
}

export function ensureDir(path: string) {
	if (!GLib.file_test(path, GLib.FileTest.EXISTS))
		Gio.File.new_for_path(path).make_directory_with_parents(null)
}

export function icon(name: string | null, fallback = icons.missing) {
	if (!name)
		return fallback || ""

	if (GLib.file_test(name, GLib.FileTest.EXISTS))
		return name

	const icon = (substitutes[name as keyof typeof substitutes] || name)
	if (lookUpIcon(icon))
		return icon
	return fallback
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
	return execAsync(cmd).catch(err => {
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

export function getFavoriteApps(): string[] {
	try {
		const output = bashSync("dconf read /org/gnome/shell/favorite-apps", { encoding: "utf-8" })
		const favorites = JSON.parse(output.replace(/'/g, '"'))

		if (Array.isArray(favorites) && favorites.every(item => typeof item === "string")) {
			return favorites.map(item => item.replace(/\.desktop$/, ""))
		} else {
			throw new Error("Unexpected format: dconf output is not a valid array of strings.")
		}
	} catch (error) {
		console.error("Failed to read favorite apps from dconf:", error)
		return []
	}
}


export function notificationBlacklisted(notification?: number | Notifd.Notification) {
	if (typeof notification === "number") {
		var notif = notifd.get_notification(notification)
	} else if (notification) {
		notif = notification
	} else {
		throw new Error("Either 'id' or 'notification' must be provided.")
	}

	if (options.notifications.blacklist.get().includes(notif.appName || notif.desktopEntry)) {
		return true
	}
	return false
}
