import { onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle, type timer } from "$lib/time"

import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import LayerShell from "gi://Gtk4LayerShell"

import { ignore_input, schedule_monitor_window_release } from "$lib/windowing"
import { attempt, err, guard, ok, type result } from "$lib/result"
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
				gdkmonitor={gdkmonitor}
				onRealize={ignore_input}
				onMap={ignore_input}
				keymode={NONE}
				focusable={false}
				decorated={false}
				css={flat_black_css}
				visible
			>
				<Gtk.Stack
					$={(self) => setup_crossfade_stack(self, pictures)}
					css={flat_black_css}
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
			rearrange() {
				if (!window.get_mapped()) return
				LayerShell.set_margin(window, LayerShell.Edge.LEFT, 1)
				LayerShell.set_margin(window, LayerShell.Edge.LEFT, 0)
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
const slot_names = ["a", "b"] as const
const flat_black_css =
	"background: black; border: none; border-radius: 0; box-shadow: none; margin: 0; padding: 0;"

function advance_gif(gif: active_gif) {
	if (!gif.iter.advance(null)) return
	const pixbuf = gif.iter.get_pixbuf()
	if (!pixbuf) return
	gif.current = Gdk.Texture.new_for_pixbuf(pixbuf)
	for (const picture of gif.pictures) picture.set_paintable(gif.current)
}

function schedule_gif(gif: active_gif) {
	const delay = Math.max(10, gif.iter.get_delay_time())
	gif.source_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
		gif.source_id = 0
		if (gif.pictures.size === 0) return GLib.SOURCE_REMOVE
		advance_gif(gif)
		schedule_gif(gif)
		return GLib.SOURCE_REMOVE
	})
}

function start_gif(
	key: string,
	animation: GdkPixbuf.PixbufAnimation,
): active_gif {
	const iter = animation.get_iter(null)
	const pixbuf = iter.get_pixbuf()
	const gif: active_gif = {
		iter,
		pictures: new Set(),
		current: pixbuf ? Gdk.Texture.new_for_pixbuf(pixbuf) : null,
		source_id: 0,
	}
	active_gifs.set(key, gif)
	schedule_gif(gif)
	return gif
}

function play_gif(
	key: string,
	gif: active_gif,
	picture: Gtk.Picture,
): () => void {
	gif.pictures.add(picture)
	if (gif.current) picture.set_paintable(gif.current)

	return () => {
		gif.pictures.delete(picture)
		if (gif.pictures.size > 0) return
		if (gif.source_id > 0) GLib.source_remove(gif.source_id)
		active_gifs.delete(key)
	}
}

function show_static_image(
	key: string,
	texture: Gdk.Texture,
	picture: Gtk.Picture,
) {
	static_image = { key, texture }
	picture.set_paintable(texture)
}

function paint_animation(
	path: string,
	key: string,
	picture: Gtk.Picture,
): result<() => void> {
	const decoded = attempt(() => GdkPixbuf.PixbufAnimation.new_from_file(path))
	if (!decoded.ok) return decoded

	const animation = decoded.value
	if (!animation.is_static_image())
		return ok(play_gif(key, start_gif(key, animation), picture))

	const image = animation.get_static_image()
	if (!image) return err(new Error("Wallpaper decoder returned no image"))
	show_static_image(key, Gdk.Texture.new_for_pixbuf(image), picture)
	return ok(() => {})
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
	const running = active_gifs.get(key)
	if (running) return play_gif(key, running, picture)

	const animated = guard(() => paint_animation(path, key, picture))
	if (animated.ok) return animated.value

	const fallback = attempt(() => Gdk.Texture.new_from_filename(path))
	if (!fallback.ok) {
		console.error(
			`wallpaper.paint: Failed to render ${path}`,
			new Error("All wallpaper decoders failed", {
				cause: { animated: animated.err, static: fallback.err },
			}),
		)
		return () => {}
	}
	show_static_image(key, fallback.value, picture)
	return () => {}
}

function setup_crossfade_stack(
	stack: Gtk.Stack,
	pictures: [Gtk.Picture, Gtk.Picture],
) {
	let slot: 0 | 1 = 1
	let transition_timer: timer | null = null

	stack.add_named(pictures[0], slot_names[0])
	stack.add_named(pictures[1], slot_names[1])
	stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)

	let stop_animation = paint(
		wallpaper_path,
		wallpaper_revision.peek(),
		pictures[slot],
	)
	stack.set_transition_duration(0)
	stack.set_visible_child_name(slot_names[slot])
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
			stack.set_visible_child_name(slot_names[next])
		})
	})
	onCleanup(() => {
		unsubscribe()
		transition_timer?.cancel()
		stop_animation()
	})
}
