// Starts the wallpaper parent and child processes and draws animated images on each monitor.

import app from "ags/gtk4/app"
import { createBinding, createRoot, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject, { property, register } from "ags/gobject"
import { Process, execAsync, subprocess } from "ags/process"
import { idle, interval, timeout, Timer } from "ags/time"

import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import { programArgs } from "system"

import env from "$lib/env"
import { basicMonitorKey } from "$lib/monitor-state"
import { attempt, attemptAsync } from "$lib/result"
import { releaseMonitorWindow } from "$lib/windows"

type ActiveGif = {
	iter: GdkPixbuf.PixbufAnimationIter
	pictures: Set<Gtk.Picture>
	current: Gdk.Texture | null
	sourceId: number
}

const activeGifs = new Map<string, ActiveGif>()

const { BACKGROUND } = Astal.Layer
const { IGNORE } = Astal.Exclusivity
const { NONE } = Astal.Keymode
const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

const FADE_MS = 600
const RESTART_DELAY_MS = 1000

function hasCommand(command: string) {
	const found = GLib.find_program_in_path(command) !== null
	if (!found) console.error(`wallpaper: Missing dependency ${command}`)
	return found
}

@register()
export default class Wallpaper extends GObject.Object {
	declare static $gtype: GObject.GType<Wallpaper>
	static instance: Wallpaper

	static get_default() {
		return this.instance ??= new Wallpaper()
	}

	@property(String) wallpaper: string
	@property(Number) revision: number
	#monitor: Gio.FileMonitor | null
	#notifyTimer: Timer | null
	#pollTimer: Timer
	#signature: string

	constructor() {
		super()
		this.wallpaper = `${env.paths.home}/.config/background`
		this.revision = 0
		this.#monitor = null
		this.#notifyTimer = null
		this.#signature = this.#fileSignature()

		const watched = attempt(() => Gio.File.new_for_path(GLib.path_get_dirname(this.wallpaper))
			.monitor_directory(Gio.FileMonitorFlags.NONE, null))
		if (watched.ok) {
			this.#monitor = watched.value
			this.#monitor.connect("changed", (_, file, other) => {
				if (file.get_path() === this.wallpaper || other?.get_path() === this.wallpaper)
					this.#scheduleNotify()
			})
		} else console.error("wallpaper: Failed to monitor wallpaper directory", watched.err)

		this.#pollTimer = interval(1000, () => {
			const signature = this.#fileSignature()
			if (signature !== this.#signature) this.#scheduleNotify()
		})

		let prevMonCount = app.get_monitors().length
		createBinding(app, "monitors").subscribe(() => {
			const monCount = app.get_monitors().length
			if (monCount > prevMonCount) {
				prevMonCount = monCount
				this.#scheduleNotify()
			}
		})

		app.connect("shutdown", () => {
			this.#notifyTimer?.cancel()
			this.#pollTimer.cancel()
			this.#monitor?.cancel()
		})
	}

	#fileSignature() {
		const result = attempt(() => {
			const info = Gio.File.new_for_path(this.wallpaper).query_info(
				"standard::size,time::modified,time::modified-usec,etag::value",
				Gio.FileQueryInfoFlags.NONE,
				null,
			)
			return [
				info.get_size(),
				info.get_attribute_uint64("time::modified"),
				info.get_attribute_uint32("time::modified-usec"),
				info.get_attribute_string("etag::value") ?? "",
			].join(":")
		})
		return result.ok ? result.value : "missing"
	}

	#scheduleNotify() {
		this.#notifyTimer?.cancel()
		this.#notifyTimer = timeout(75, () => {
			this.#notifyTimer = null
			this.#signature = this.#fileSignature()
			this.revision++
			this.notify("wallpaper")
		})
	}

	async #convertHeic(path: string) {
		if (!hasCommand("heif-dec")) return
		const tmpImg = `${env.paths.tmp}/heic.png`
		await execAsync(["heif-dec", path, tmpImg])
		await execAsync(["cp", tmpImg, this.wallpaper])
	}

	async clearWallpaper() {
		const result = attempt(() => {
			Gio.File.new_for_path(this.wallpaper).replace_contents(
				"",
				null,
				false,
				Gio.FileCreateFlags.REPLACE_DESTINATION,
				null,
			)
			this.#scheduleNotify()
		})
		if (!result.ok)
			console.error("wallpaper.clear: Failed to clear wallpaper", result.err)
	}

	async setWallpaper(path: string) {
		const lower = path.toLowerCase()
		const result = await attemptAsync(async () => {
			if (lower.endsWith(".heic")) {
				await this.#convertHeic(path)
			} else if (lower.endsWith(".webp")) {
				if (!hasCommand("dwebp")) throw new Error("dwebp not found")
				const tmp = `${env.paths.tmp}/wallpaper.png`
				await execAsync(["dwebp", path, "-o", tmp])
				await execAsync(["cp", tmp, this.wallpaper])
			} else {
				await execAsync(["cp", path, this.wallpaper])
			}
			this.#scheduleNotify()
		})
		if (!result.ok)
			console.error("wallpaper.set: Failed to set wallpaper", result.err)
	}
}

export const wallpaper = Wallpaper.get_default()

// Child-process rendering shares GIF frames and crossfades updates across monitor windows.
function scheduleGif(gif: ActiveGif) {
	const delay = Math.max(10, gif.iter.get_delay_time())
	gif.sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
		gif.sourceId = 0
		if (gif.pictures.size === 0) return GLib.SOURCE_REMOVE

		if (gif.iter.advance(null)) {
			const pixbuf = gif.iter.get_pixbuf()
			if (pixbuf) {
				gif.current = Gdk.Texture.new_for_pixbuf(pixbuf)
				for (const picture of gif.pictures) picture.set_paintable(gif.current)
			}
		}
		scheduleGif(gif)
		return GLib.SOURCE_REMOVE
	})
}

function playGif(key: string, animation: GdkPixbuf.PixbufAnimation, picture: Gtk.Picture): () => void {
	let gif = activeGifs.get(key)
	if (!gif) {
		const iter = animation.get_iter(null)
		const pixbuf = iter.get_pixbuf()
		gif = {
			iter,
			pictures: new Set(),
			current: pixbuf ? Gdk.Texture.new_for_pixbuf(pixbuf) : null,
			sourceId: 0,
		}
		activeGifs.set(key, gif)
		scheduleGif(gif)
	}

	gif.pictures.add(picture)
	if (gif.current) picture.set_paintable(gif.current)

	return () => {
		gif.pictures.delete(picture)
		if (gif.pictures.size === 0) {
			if (gif.sourceId > 0) GLib.source_remove(gif.sourceId)
			activeGifs.delete(key)
		}
	}
}

function paint(path: string, revision: number, picture: Gtk.Picture): () => void {
	picture.set_paintable(null)
	const animated = attempt(() => {
		const animation = GdkPixbuf.PixbufAnimation.new_from_file(path)
		if (!animation.is_static_image()) return playGif(`${path}:${revision}`, animation, picture)
		picture.set_paintable(Gdk.Texture.new_for_pixbuf(animation.get_static_image()!))
		return () => {}
	})
	if (animated.ok) return animated.value

	attempt(() => picture.set_paintable(Gdk.Texture.new_from_filename(path)))
	return () => {}
}

function setupCrossfadeStack(stack: Gtk.Stack, pictures: [Gtk.Picture, Gtk.Picture], wallpaperService: Wallpaper) {
	let slot: 0 | 1 = 1
	let stopAnim = () => {}
	let transitionTimer: Timer | null = null

	stack.add_named(pictures[0], "a")
	stack.add_named(pictures[1], "b")
	stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)

	stopAnim = paint(wallpaperService.wallpaper, wallpaperService.revision, pictures[1])
	stack.set_transition_duration(0)
	stack.set_visible_child_name("b")
	stack.set_transition_duration(FADE_MS)

	const handlerId = wallpaperService.connect("notify::wallpaper", () => {
		const next: 0 | 1 = slot === 0 ? 1 : 0
		stopAnim()
		stopAnim = paint(wallpaperService.wallpaper, wallpaperService.revision, pictures[next])
		transitionTimer?.cancel()
		transitionTimer = idle(() => {
			transitionTimer = null
			slot = next
			stack.set_visible_child_name(next === 0 ? "a" : "b")
		})
	})
	onCleanup(() => {
		wallpaperService.disconnect(handlerId)
		transitionTimer?.cancel()
		stopAnim()
	})
}

export namespace WallpaperWindow {
	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		const wallpaperService = wallpaper
		const geometry = gdkmonitor.get_geometry()
		const pictures: [Gtk.Picture, Gtk.Picture] = [new Gtk.Picture(), new Gtk.Picture()]
		for (const picture of pictures) {
			picture.content_fit = Gtk.ContentFit.COVER
			picture.hexpand = true
			picture.vexpand = true
		}

		const win = (
			<window
				name="wallpaper"
				namespace="wallpaper"
				layer={BACKGROUND}
				exclusivity={IGNORE}
				anchor={TOP | BOTTOM | LEFT | RIGHT}
				application={app}
				gdkmonitor={gdkmonitor}
				keymode={NONE}
				focusable={false}
				decorated={false}
				css="background: black; border: none; border-radius: 0; box-shadow: none; margin: 0; padding: 0;"
				visible
			>
				<Gtk.Stack
					$={self => setupCrossfadeStack(self, pictures, wallpaperService)}
					widthRequest={geometry.width}
					heightRequest={geometry.height}
					css="background: black; border: none; border-radius: 0; box-shadow: none; margin: 0; padding: 0;"
					hexpand
					vexpand
				/>
			</window>
		) as Gtk.Window

		onCleanup(() => releaseMonitorWindow(win))

		return win
	}
}

// Main-process supervision restarts the isolated renderer and terminates it with the shell.
let child: Process | null = null
let restartTimer: Timer | null = null
let stopping = false

function scheduleRestart() {
	if (!stopping && !restartTimer)
		restartTimer = timeout(RESTART_DELAY_MS, spawnChild)
}

function sourceEntry() {
	const roots = [
		GLib.getenv("AGS2SHELL_STYLES"),
		typeof SRC !== "undefined" ? SRC : null,
		GLib.get_current_dir(),
		env.paths.cfg,
	]

	for (const root of roots) {
		if (!root) continue
		const entry = GLib.build_filenamev([root, "wallpaper.tsx"])
		if (GLib.file_test(entry, GLib.FileTest.EXISTS)) return entry
	}

	return null
}

function childCommand() {
	const parentPid = GLib.file_read_link("/proc/self")
	const parentArg = `--parent-pid=${parentPid}`
	if (typeof WALLPAPER_BIN !== "undefined" && GLib.file_test(WALLPAPER_BIN, GLib.FileTest.IS_EXECUTABLE))
		return [WALLPAPER_BIN, parentArg]

	const entry = sourceEntry()
	return entry ? ["ags", "run", "--gtk", "4", entry, "--", parentArg] : null
}

function spawnChild() {
	restartTimer = null
	if (stopping || child) return

	const command = childCommand()
	if (!command) {
		console.error("wallpaper: Could not locate wallpaper.tsx")
		scheduleRestart()
		return
	}

	let lastError = ""
	try {
		const process = subprocess(command, print, error => lastError = error)
		child = process
		process.connect("exit", (_, code, signaled) => {
			if (child !== process) return
			child = null
			if (stopping) return

			const reason = signaled ? `signal ${code}` : `status ${code}`
			console.error(`wallpaper: Child exited with ${reason}${lastError ? `: ${lastError}` : ""}`)
			scheduleRestart()
		})
	} catch (error) {
		console.error("wallpaper: Failed to start child", error)
		scheduleRestart()
	}
}

export function startWallpaperProcess() {
	stopping = false
	spawnChild()

	app.connect("shutdown", () => {
		stopping = true
		restartTimer?.cancel()
		restartTimer = null
		const process = child
		child = null
		process?.kill()
	})
}

function monitorKey(monitor: Gdk.Monitor, index: number) {
	const geometry = monitor.get_geometry()
	return basicMonitorKey(monitor, `${index}:${monitor.get_description() ?? "unknown"}:${geometry.x}x${geometry.y}`)
}

function initWallpaperMonitors() {
	const active = new Map<string, { monitor: Gdk.Monitor, dispose: () => void }>()

	const sync = () => {
		const current = new Map(app.get_monitors().map((monitor, index) => [monitorKey(monitor, index), monitor]))

		for (const [key, slot] of active) {
			const monitor = current.get(key)
			if (!monitor || monitor !== slot.monitor) {
				slot.dispose()
				active.delete(key)
			}
		}

		for (const [key, monitor] of current) {
			if (active.has(key)) continue
			const dispose = createRoot(dispose => {
				WallpaperWindow.Window({ gdkmonitor: monitor })
				return dispose
			})
			active.set(key, { monitor, dispose })
		}
	}

	app.connect("notify::monitors", sync)
	app.connect("shutdown", () => {
		for (const slot of active.values()) slot.dispose()
		active.clear()
	})
	sync()
}

export function startWallpaperApp() {
	const parentPid = programArgs
		.find(arg => arg.startsWith("--parent-pid="))
		?.slice("--parent-pid=".length)
	const instanceSuffix = parentPid ?? GLib.uuid_string_random()

	app.start({
		instanceName: `${env.appName}-wallpaper-${instanceSuffix}`,
		main() {
			env.init()
			initWallpaperMonitors()

			if (parentPid) {
				const watchdog = interval(1000, () => {
					if (!GLib.file_test(`/proc/${parentPid}`, GLib.FileTest.EXISTS)) app.quit()
				})
				app.connect("shutdown", () => watchdog.cancel())
			}
		},
	})
}
