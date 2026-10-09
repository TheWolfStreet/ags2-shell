import app from "$lib/app"
import { onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle, type Timer } from "$lib/time"

import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"

import { ignore_input, schedule_monitor_window_release } from "$lib/windowing"
import { attempt } from "$lib/result"
import { wallpaper_path, wallpaper_revision } from "$lib/wallpaper"

export namespace Wallpaper {
	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		const pictures: [Gtk.Picture, Gtk.Picture] = [
			new Gtk.Picture(),
			new Gtk.Picture(),
		]
		for (const picture of pictures) {
			picture.content_fit = Gtk.ContentFit.COVER
			picture.can_shrink = true
			picture.hexpand = true
			picture.vexpand = true
		}

		const window = (
			<window
				name="wallpaper"
				namespace="wallpaper"
				layer={BACKGROUND}
				exclusivity={IGNORE}
				anchor={TOP | BOTTOM | LEFT | RIGHT}
				application={app}
				gdkmonitor={gdkmonitor}
				onRealize={ignore_input}
				onMap={ignore_input}
				keymode={NONE}
				focusable={false}
				decorated={false}
				css="background: black; border: none; border-radius: 0; box-shadow: none; margin: 0; padding: 0;"
				visible
			>
				<Gtk.Stack
					$={(self) => setup_crossfade_stack(self, pictures)}
					css="background: black; border: none; border-radius: 0; box-shadow: none; margin: 0; padding: 0;"
					hexpand
					vexpand
				/>
			</window>
		) as Gtk.Window

		onCleanup(() => {
			schedule_monitor_window_release(window)
		})

		return {
			retarget(next_monitor: Gdk.Monitor) {
				window.set_property("gdkmonitor", next_monitor)
			},
		}
	}
}

type active_gif = {
	iter: GdkPixbuf.PixbufAnimationIter
	pictures: Set<Gtk.Picture>
	current: Gdk.Texture | null
	source_id: number
}

const active_gifs = new Map<string, active_gif>()
let static_image: { key: string; texture: Gdk.Texture } | null = null

const { BACKGROUND } = Astal.Layer
const { IGNORE } = Astal.Exclusivity
const { NONE } = Astal.Keymode
const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

const fade_ms = 600

function schedule_gif(gif: active_gif) {
	const delay = Math.max(10, gif.iter.get_delay_time())
	gif.source_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
		gif.source_id = 0
		if (gif.pictures.size === 0) return GLib.SOURCE_REMOVE

		if (gif.iter.advance(null)) {
			const pixbuf = gif.iter.get_pixbuf()
			if (pixbuf) {
				gif.current = Gdk.Texture.new_for_pixbuf(pixbuf)
				for (const picture of gif.pictures) picture.set_paintable(gif.current)
			}
		}
		schedule_gif(gif)
		return GLib.SOURCE_REMOVE
	})
}

function play_gif(
	key: string,
	picture: Gtk.Picture,
	animation?: GdkPixbuf.PixbufAnimation,
): () => void {
	let gif = active_gifs.get(key)
	if (!gif) {
		if (!animation) return () => {}
		const iter = animation.get_iter(null)
		const pixbuf = iter.get_pixbuf()
		gif = {
			iter,
			pictures: new Set(),
			current: pixbuf ? Gdk.Texture.new_for_pixbuf(pixbuf) : null,
			source_id: 0,
		}
		active_gifs.set(key, gif)
		schedule_gif(gif)
	}

	gif.pictures.add(picture)
	if (gif.current) picture.set_paintable(gif.current)

	return () => {
		gif.pictures.delete(picture)
		if (gif.pictures.size === 0) {
			if (gif.source_id > 0) GLib.source_remove(gif.source_id)
			active_gifs.delete(key)
		}
	}
}

function paint(
	path: string,
	revision: number,
	picture: Gtk.Picture,
): () => void {
	picture.set_paintable(null)
	const key = `${path}:${revision}`
	if (static_image?.key === key) {
		picture.set_paintable(static_image.texture)
		return () => {}
	}
	if (active_gifs.has(key)) return play_gif(key, picture)
	const animated = attempt(() => {
		const animation = GdkPixbuf.PixbufAnimation.new_from_file(path)
		if (!animation.is_static_image()) return play_gif(key, picture, animation)
		const image = animation.get_static_image()
		if (!image) throw new Error("Wallpaper decoder returned no image")
		const texture = Gdk.Texture.new_for_pixbuf(image)
		static_image = { key, texture }
		picture.set_paintable(texture)
		return () => {}
	})
	if (animated.ok) return animated.value

	const fallback = attempt(() => {
		const texture = Gdk.Texture.new_from_filename(path)
		static_image = { key, texture }
		picture.set_paintable(texture)
	})
	if (!fallback.ok)
		console.error(
			`wallpaper.paint: Failed to render ${path}`,
			new Error("All wallpaper decoders failed", {
				cause: { animated: animated.err, static: fallback.err },
			}),
		)
	return () => {}
}

function setup_crossfade_stack(
	stack: Gtk.Stack,
	pictures: [Gtk.Picture, Gtk.Picture],
) {
	let slot: 0 | 1 = 1
	let stop_animation = () => {}
	let transition_timer: Timer | null = null

	stack.add_named(pictures[0], "a")
	stack.add_named(pictures[1], "b")
	stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)

	stop_animation = paint(wallpaper_path, wallpaper_revision.peek(), pictures[1])
	stack.set_transition_duration(0)
	stack.set_visible_child_name("b")
	stack.set_transition_duration(fade_ms)

	const unsubscribe = wallpaper_revision.subscribe(() => {
		const next: 0 | 1 = slot === 0 ? 1 : 0
		stop_animation()
		stop_animation = paint(
			wallpaper_path,
			wallpaper_revision.peek(),
			pictures[next],
		)
		transition_timer?.cancel()
		transition_timer = idle(() => {
			transition_timer = null
			slot = next
			stack.set_visible_child_name(next === 0 ? "a" : "b")
		})
	})
	onCleanup(() => {
		unsubscribe()
		transition_timer?.cancel()
		stop_animation()
	})
}
