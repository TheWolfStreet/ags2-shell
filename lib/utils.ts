import app from "ags/gtk4/app"
import { CCProps, createBinding, createComputed } from "ags"
import { Gdk } from "ags/gtk4"
import { exec, execAsync } from "ags/process"

import Apps from "gi://AstalApps"
import Gtk from "gi://Gtk"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import AstalHyprland from "gi://AstalHyprland"
import GdkPixbuf from "gi://GdkPixbuf"

import giCairo from "cairo"

import env from "$lib/env"
import icons from "$lib/icons"
import { hypr } from "$lib/services"

export type Props<T extends Gtk.Widget, Props> = CCProps<T, Partial<Props>>

export function getClientTitle(c: AstalHyprland.Client) {
	return createComputed(
		[
			createBinding(c, "title"),
			createBinding(c, "class")
		],
		(title, className) => {
			if (title?.length) return title
			const name = (className || "Unknown").split(".").pop()!
			return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
		}
	)
}

export function getFileSize(filePath: string): number | null {
	if (!filePath || !fileExists(filePath)) return null;

	try {
		const info = Gio.File.new_for_path(filePath).query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
		return info.get_size();
	} catch {
		return null;
	}
}

export function textureFromFile(filePath: string, width?: number, height?: number): Gdk.Texture | null {
	if (!getFileSize(filePath)) {
		console.warn(`textureFromFile: File not found or empty: ${filePath}`)
		return null
	}

	try {
		let pixbuf = GdkPixbuf.Pixbuf.new_from_file(filePath)
		if (width && height) {
			pixbuf = pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)!
		}
		return Gdk.Texture.new_for_pixbuf(pixbuf)
	} catch (e) {
		console.error(`textureFromFile: Failed to load ${filePath}:`, e)
		return null
	}
}

export function textureFromUri(uri: string, width?: number, height?: number): Gdk.Texture | null {
	if (!uri) return null

	if (uri.startsWith("/") || uri.startsWith("file://")) {
		const filePath = uri.startsWith("file://") ? uri.slice(7) : uri
		return textureFromFile(filePath, width, height)
	}

	if (uri.startsWith("http://") || uri.startsWith("https://")) {
		try {
			const cacheDir = GLib.get_user_cache_dir() + "/ags2-shell/covers"
			GLib.mkdir_with_parents(cacheDir, 0o755)

			const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, uri, -1)
			const cachePath = `${cacheDir}/${hash}`

			if (fileExists(cachePath)) {
				return textureFromFile(cachePath, width, height)
			}

			const file = Gio.File.new_for_uri(uri)
			const destFile = Gio.File.new_for_path(cachePath)

			try {
				file.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null)
				return textureFromFile(cachePath, width, height)
			} catch (e) {
				console.error(`textureFromUri: Failed to download ${uri}:`, e)
				return null
			}
		} catch (e) {
			console.error(`textureFromUri: Error handling HTTP URL ${uri}:`, e)
			return null
		}
	}

	if (uri.startsWith("data:image/") || uri.includes("iVBORw0KGgo") || uri.includes("/9j/")) {
		try {
			const base64Data = uri.startsWith("data:") ? uri.split(",")[1] : uri
			const cleaned = base64Data.replace(/\s/g, "")
			const bytes = GLib.base64_decode(cleaned)

			const loader = GdkPixbuf.PixbufLoader.new()
			loader.write_bytes(bytes)
			loader.close()

			let pixbuf = loader.get_pixbuf()
			if (!pixbuf) {
				console.warn("textureFromUri: Failed to decode base64 data")
				return null
			}

			if (width && height) {
				pixbuf = pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)!
			}
			return Gdk.Texture.new_for_pixbuf(pixbuf)
		} catch (e) {
			console.error(`textureFromUri: Failed to process base64 data:`, e)
			return null
		}
	}

	return null
}

export function fileExists(path: string) { return GLib.file_test(path, GLib.FileTest.EXISTS) }

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

export async function notify(opts: {
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
		const {
			id,
			appName = "",
			appIcon = "",
			actions = {},
			body = "",
			summary = "",
			urgency = "normal",
			timeout,
			hints = {},
		} = opts

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
		const retId = Number(result.split("\n")[0])
		if (Object.keys(actions).length > 0) {
			execAsync(result.split("\n")[1]).catch(() => null)
		}
		return retId
	} catch {
		return undefined
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

export function duration(length: number) {
	const hours = Math.floor(length / 3600)
	const minutes = Math.floor((length % 3600) / 60)
	const seconds = Math.floor(length % 60)

	const mm = minutes.toString().padStart(hours ? 2 : 1, "0")
	const ss = seconds.toString().padStart(2, "0")

	return hours
		? `${hours}:${mm}:${ss}`
		: `${minutes}:${ss}`
}

export function range(length: number, start = 1) {
	return Array.from({ length }, (_, i) => i + start)
}

export function ensurePath(path: string) {
	const isDir = path.endsWith("/")

	if (fileExists(path))
		return

	const file = Gio.File.new_for_path(path)

	if (isDir) {
		file.make_directory_with_parents(null)
	} else {
		const parent = file.get_parent()
		if (parent) {
			const parentPath = parent.get_path()
			if (parentPath && !GLib.file_test(parentPath, GLib.FileTest.EXISTS)) {
				parent.make_directory_with_parents(null)
			}
		}
		file.create(Gio.FileCreateFlags.PRIVATE, null)
	}
}


export function icon(name?: string, fallback = icons.missing): string {
	if (name && env.iconTheme.get().has_icon(name)) {
		return name
	}
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
	return execAsync(cmd).catch((err: unknown) => {
		console.error(typeof cmd === "string" ? cmd : cmd.join(" "), err)
		return ""
	})
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
