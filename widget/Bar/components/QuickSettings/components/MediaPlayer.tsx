import { Gdk, Gtk } from "ags/gtk4"

import { createBinding, createComputed, createState, onCleanup } from "ags"
import { timeout, type Timer } from "$lib/time"

import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import icons from "$lib/icons"
import { debounce, format_clock } from "$lib/time"
import { create_square_texture_accessor } from "$lib/textures"

import options from "$shell/options"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit
const duration_cache = new Map<string, number>()
const duration_cache_limit = 64
const cover_size = options.scale.as(scale => Math.round(100 * scale / 100))

function remember_duration(track: string, duration: number) {
	if (duration_cache.has(track)) duration_cache.delete(track)
	duration_cache.set(track, duration)
	if (duration_cache.size > duration_cache_limit) {
		const oldest = duration_cache.keys().next().value
		if (oldest) duration_cache.delete(oldest)
	}
}

function metadata_length(metadata: GLib.Variant) {
	const value = metadata?.lookup_value("mpris:length", null)
	const unpacked: unknown = value?.deepUnpack()
	return typeof unpacked === "number" && unpacked > 0 ? unpacked / 1_000_000 : 0
}

export function MediaPlayer({ player }: { player: AstalMpris.Player }) {
	const { PLAYING } = AstalMpris.PlaybackStatus
	const { PLAYLIST, TRACK, NONE } = AstalMpris.Loop
	const { ON, OFF } = AstalMpris.Shuffle

	const title = createBinding(player, "title").as(title => title || "Untitled")
	const artist = createBinding(player, "artist").as(artist => artist || "Unknown Artist")
	const cover_art = createBinding(player, "coverArt")
	const art_url = createBinding(player, "artUrl")
	const cover_uri = createComputed(() => art_url() || cover_art() || "")
	const selected_cover = createComputed(() => create_square_texture_accessor(cover_uri(), cover_size()))
	const cover_texture = createComputed(() => selected_cover()())
	const has_cover_art = cover_texture.as(texture => texture !== null)
	const text_max_width = 20
	const player_icon = createBinding(player, "entry").as(entry => entry || "audio-x-generic-symbolic")
	const position = createBinding(player, "position")
	const reported_length = createBinding(player, "length")
	const metadata = createBinding(player, "metadata")
	const track_id = createBinding(player, "trackid")
	const track_key = createComputed(() => `${track_id()}|${title()}|${art_url()}`)
	let current_track = track_key.peek()
	let known_length = duration_cache.get(current_track) ?? Math.max(0, player.length)
	const length = createComputed(() => {
		const next_track = track_key()
		if (next_track !== current_track) {
			current_track = next_track
			known_length = duration_cache.get(current_track) ?? 0
		}
		const duration = Math.max(reported_length(), metadata_length(metadata()))
		if (duration > 0) {
			known_length = duration
			remember_duration(current_track, duration)
		}
		return known_length
	})
	const normalized_position = createComputed(() => {
		const duration = length()
		return duration > 0 ? Math.min(1, Math.max(0, position()) / duration) : 0
	})
	const playback_status = createBinding(player, "playbackStatus")
	const loop_status = createBinding(player, "loopStatus")
	const shuffle_status = createBinding(player, "shuffleStatus")
	const can_control = createBinding(player, "canControl")
	const can_go_next = createBinding(player, "canGoNext")
	const can_go_previous = createBinding(player, "canGoPrevious")
	const can_seek = createBinding(player, "canSeek")

	const remaining = createComputed(() => Math.max(0, length() - position()))
	const [pending_position, set_pending_position] = createState<number | null>(null)
	const displayed_position = createComputed(() => pending_position() ?? normalized_position())
	const seek = debounce<[number]>(60, value => {
		const duration = length.peek()
		if (duration > 0) player.position = value * duration
	})
	let settle_timer: Timer | null = null
	const release_pending_position = () => {
		settle_timer?.cancel()
		settle_timer = null
		set_pending_position(null)
	}
	const dispose_position = normalized_position.subscribe(() => {
		const value = normalized_position.peek()
		const pending = pending_position.peek()
		if (pending !== null && Math.abs(value - pending) < 0.02)
			release_pending_position()
	})
	const dispose_track = track_key.subscribe(() => {
		seek.cancel()
		release_pending_position()
	})
	onCleanup(() => {
		seek.cancel()
		dispose_position()
		dispose_track()
		settle_timer?.cancel()
	})

	const play_icon = playback_status.as(status => status === PLAYING ? icons.mpris.playing : icons.mpris.paused)
	const loop_descriptor = loop_status.as(status => {
		switch (status) {
			case NONE: return { icon: icons.mpris.loop.none, tooltip: "Loop: Disabled" }
			case TRACK: return { icon: icons.mpris.loop.track, tooltip: "Loop: Track" }
			case PLAYLIST: return { icon: icons.mpris.loop.playlist, tooltip: "Loop: Playlist" }
			default: return { icon: icons.mpris.loop.none, tooltip: "Loop: Disabled" }
		}
	})

	function cycle_loop() {
		switch (player.loopStatus) {
			case NONE: player.set_loop_status(PLAYLIST); break
			case PLAYLIST: player.set_loop_status(TRACK); break
			case TRACK: player.set_loop_status(NONE); break
			default: break
		}
	}

	function cycle_shuffle() {
		switch (player.shuffleStatus) {
			case OFF: player.set_shuffle_status(ON); break
			case ON: player.set_shuffle_status(OFF); break
			default: break
		}
	}
	return (
		<box class="player" vexpand={false}>
			<Gtk.Picture
				class="cover-art"
				visible={has_cover_art}
				widthRequest={cover_size}
				heightRequest={cover_size}
				halign={CENTER}
				valign={CENTER}
				paintable={cover_texture.as(texture => texture as Gdk.Paintable)}
				contentFit={COVER}
				canShrink
			/>

			<box orientation={VERTICAL}>
				<box class="title horizontal">
					<label
						label={title}
						halign={START}
						wrap hexpand
						ellipsize={Pango.EllipsizeMode.END}
						lines={2}
						maxWidthChars={text_max_width}
					/>
					<image iconName={player_icon} useFallback />
				</box>
				<label
					class="artist"
					label={artist}
					halign={START}
					valign={START}
					wrap vexpand
					ellipsize={Pango.EllipsizeMode.END}
					lines={3}
					maxWidthChars={text_max_width}
				/>
				<slider
					tooltipText={length.as(duration => duration > 0 ? `Duration: ${format_clock(duration)}` : "Duration unavailable")}
					visible={length.as(duration => duration > 0)}
					sensitive={createComputed(() => can_seek() && length() > 0)}
					onChangeValue={({ value }) => {
						set_pending_position(value)
						seek.call(value)
						settle_timer?.cancel()
						settle_timer = timeout(1500, release_pending_position)
					}}
					value={displayed_position}
				/>
				<box class="horizontal">
					<label
						hexpand
						class="position"
						halign={START}
						visible={length.as(duration => duration > 0)}
						label={position.as(format_clock)}
					/>
					<box hexpand halign={CENTER}>
						<button
							class={shuffle_status.as(status => status === ON ? "active" : "")}
							onClicked={cycle_shuffle}
							visible={shuffle_status.as(status => status != AstalMpris.Shuffle.UNSUPPORTED)}>
							<image iconName={icons.mpris.shuffle} useFallback />
						</button>
						<button onClicked={() => player.previous()} visible={can_go_previous}>
							<image iconName={icons.mpris.prev} useFallback />
						</button>
						<button class="play-pause" onClicked={() => player.play_pause()} visible={can_control}>
							<image iconName={play_icon} useFallback />
						</button>
						<button onClicked={() => player.next()} visible={can_go_next}>
							<image iconName={icons.mpris.next} useFallback />
						</button>
						<button
							class={loop_status.as(status => status !== NONE && status !== AstalMpris.Loop.UNSUPPORTED ? "active" : "")}
							tooltipText={loop_descriptor.as(descriptor => descriptor.tooltip)}
							onClicked={cycle_loop}
							visible={loop_status.as(status => status != AstalMpris.Loop.UNSUPPORTED)}
						>
							<image iconName={loop_descriptor.as(descriptor => descriptor.icon)} useFallback />
						</button>
					</box>
					<label
						class="length"
						hexpand
						halign={END}
						visible={length.as(duration => duration > 0)}
						label={remaining.as(format_clock)}
					/>
				</box>
			</box>
		</box>
	)
}
