// Draws animated wallpaper images on each monitor.

import app from "ags/gtk4/app"
import { createState, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle, interval, Timer } from "ags/time"

import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"

import { scheduleMonitorWindowRelease } from "$lib/windowing"
import { attempt } from "$lib/result"
import { wallpaperService } from "$service/wallpaper"

export namespace Wallpaper {
	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		let monitorName = gdkmonitor.get_connector() ?? ""
		const initialGeometry = gdkmonitor.get_geometry()
		const [size, setSize] = createState(readMonitorSize(monitorName) ?? {
			width: initialGeometry.width,
			height: initialGeometry.height,
		})
		const syncSize = () => {
			const next = readMonitorSize(monitorName)
			const current = size.peek()
			if (next && (next.width !== current.width || next.height !== current.height))
				setSize(next)
		}
		const sizeTimer = interval(100, syncSize)
		const pictures: [Gtk.Picture, Gtk.Picture] = [new Gtk.Picture(), new Gtk.Picture()]
		for (const picture of pictures) {
			picture.content_fit = Gtk.ContentFit.COVER
			picture.can_shrink = true
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
				widthRequest={size.as(current => current.width)}
				heightRequest={size.as(current => current.height)}
				keymode={NONE}
				focusable={false}
				decorated={false}
				css="background: black; border: none; border-radius: 0; box-shadow: none; margin: 0; padding: 0;"
				visible
			>
				<Gtk.Stack
					$={self => setupCrossfadeStack(self, pictures)}
					widthRequest={size.as(current => current.width)}
					heightRequest={size.as(current => current.height)}
					css="background: black; border: none; border-radius: 0; box-shadow: none; margin: 0; padding: 0;"
					hexpand
					vexpand
				/>
			</window>
		) as Gtk.Window

		onCleanup(() => {
			sizeTimer.cancel()
			scheduleMonitorWindowRelease(win)
		})

		return {
			retarget(nextMonitor: Gdk.Monitor) {
				win.set_property("gdkmonitor", nextMonitor)
				monitorName = nextMonitor.get_connector() ?? monitorName
				syncSize()
			},
		}
	}
}

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

type MonitorSize = {
	width: number
	height: number
}

type MonitorSizeSnapshot = MonitorSize & {
	name?: string
}

function readMonitorSize(monitorName: string): MonitorSize | null {
	try {
		const monitors = JSON.parse(AstalHyprland.get_default().message("j/monitors")) as MonitorSizeSnapshot[]
		const monitor = monitors.find(monitor => monitor.name === monitorName)
		return monitor ? { width: monitor.width, height: monitor.height } : null
	} catch {
		return null
	}
}

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
		return () => { }
	})
	if (animated.ok) return animated.value

	const fallback = attempt(() => picture.set_paintable(Gdk.Texture.new_from_filename(path)))
	if (!fallback.ok)
		console.error(`wallpaper.paint: Failed to render ${path}`, new Error("All wallpaper decoders failed", {
			cause: { animated: animated.err, static: fallback.err },
		}))
	return () => { }
}

function setupCrossfadeStack(stack: Gtk.Stack, pictures: [Gtk.Picture, Gtk.Picture]) {
	let slot: 0 | 1 = 1
	let stopAnim = () => { }
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
