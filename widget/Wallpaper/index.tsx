import app from "ags/gtk4/app"
import { createState, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import { wp } from "$lib/services"
import { attempt } from "$lib/result"
import { releaseMonitorWindow } from "$lib/utils"
import type { MonitorControl } from "$lib/monitors"

type ActiveGif = {
	iter: GdkPixbuf.PixbufAnimationIter
	pics: Set<Gtk.Picture>
	current: Gdk.Texture | null
}

const activeGifs = new Map<string, ActiveGif>()

const { BACKGROUND } = Astal.Layer
const { IGNORE } = Astal.Exclusivity
const { NONE } = Astal.Keymode
const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

const FADE_MS = 600

function playGif(path: string, anim: GdkPixbuf.PixbufAnimation, pic: Gtk.Picture): () => void {
	let gif = activeGifs.get(path)
	if (!gif) {
		const iter = anim.get_iter(null)
		const pb = iter.get_pixbuf()
		gif = {
			iter,
			pics: new Set(),
			current: pb ? Gdk.Texture.new_for_pixbuf(pb) : null,
		}
		activeGifs.set(path, gif)
	}

	gif.pics.add(pic)
	if (gif.current) pic.set_paintable(gif.current)

	let dead = false
	const id = pic.add_tick_callback(() => {
		if (dead) return GLib.SOURCE_REMOVE

		if (gif.iter.advance(null)) {
			const pb = gif.iter.get_pixbuf()
			if (pb) {
				gif.current = Gdk.Texture.new_for_pixbuf(pb)
				for (const p of gif.pics) p.set_paintable(gif.current)
			}
		}
		return GLib.SOURCE_CONTINUE
	})

	return () => {
		dead = true
		pic.remove_tick_callback(id)
		gif.pics.delete(pic)
		if (gif.pics.size === 0) activeGifs.delete(path)
	}
}

function paint(path: string, pic: Gtk.Picture): () => void {
	const animated = attempt(() => {
		const anim = GdkPixbuf.PixbufAnimation.new_from_file(path)
		if (!anim.is_static_image()) return playGif(path, anim, pic)
		pic.set_paintable(Gdk.Texture.new_for_pixbuf(anim.get_static_image()!))
		return () => {}
	})
	if (animated.ok) return animated.value

	attempt(() => pic.set_paintable(Gdk.Texture.new_from_filename(path)))
	return () => {}
}

function setupCrossfadeStack(stack: Gtk.Stack, pics: [Gtk.Picture, Gtk.Picture], svc: typeof wp) {
	let slot: 0 | 1 = 1
	let stopAnim = () => {}

	stack.add_named(pics[0], "a")
	stack.add_named(pics[1], "b")
	stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)

	stopAnim = paint(svc.wallpaper, pics[1])
	stack.set_transition_duration(0)
	stack.set_visible_child_name("b")
	stack.set_transition_duration(FADE_MS)

	const id = svc.connect("notify::wallpaper", () => {
		const next: 0 | 1 = slot === 0 ? 1 : 0
		stopAnim()
		stopAnim = paint(svc.wallpaper, pics[next])
		idle(() => {
			slot = next
			stack.set_visible_child_name(next === 0 ? "a" : "b")
		})
	})
	onCleanup(() => { svc.disconnect(id); stopAnim() })
}

export namespace WallpaperWindow {
	export function Window({ gdkmonitor, control, initialVisible = true }: { gdkmonitor: Gdk.Monitor, control?: Partial<MonitorControl>, initialVisible?: boolean }) {
		const svc = wp
		const [shown, setShown] = createState(initialVisible)
		const pics: [Gtk.Picture, Gtk.Picture] = [new Gtk.Picture(), new Gtk.Picture()]
		for (const p of pics) {
			p.content_fit = Gtk.ContentFit.COVER
			p.hexpand = true
			p.vexpand = true
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
				visible={shown}
			>
				<Gtk.Stack
					$={self => setupCrossfadeStack(self, pics, svc)}
					hexpand
					vexpand
				/>
			</window>
		) as Gtk.Window

		if (control) {
			control.park = () => setShown(false)
			control.unpark = (mon) => {
				win.set_property("gdkmonitor", mon)
				setShown(true)
			}
		}

		onCleanup(() => releaseMonitorWindow(win))

		return win
	}
}
