import { Gdk, Gtk } from "ags/gtk4"

import {
	Accessor,
	createBinding,
	createComputed,
	createState,
	onCleanup,
} from "ags"

import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import icons from "$lib/icons"
import { debounce, format_clock, timeout, type timer } from "$lib/time"
import { create_texture_accessor } from "$lib/textures"

import { scaled } from "$shell/options"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit
const { PLAYING } = AstalMpris.PlaybackStatus
const { PLAYLIST, TRACK, NONE, UNSUPPORTED: loop_unsupported } = AstalMpris.Loop
const { ON, OFF, UNSUPPORTED: shuffle_unsupported } = AstalMpris.Shuffle
const duration_cache = new Map<string, number>()
const duration_cache_limit = 64
const cover_size = scaled(100)

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

function loop_descriptor(status: AstalMpris.Loop) {
	if (status === TRACK)
		return { icon: icons.mpris.loop.track, tooltip: "Loop: Track" }
	if (status === PLAYLIST)
		return { icon: icons.mpris.loop.playlist, tooltip: "Loop: Playlist" }
	return { icon: icons.mpris.loop.none, tooltip: "Loop: Disabled" }
}

function next_loop(status: AstalMpris.Loop) {
	if (status === NONE) return PLAYLIST
	if (status === PLAYLIST) return TRACK
	if (status === TRACK) return NONE
	return null
}

function next_shuffle(status: AstalMpris.Shuffle) {
	if (status === OFF) return ON
	if (status === ON) return OFF
	return null
}

function track_length(player: AstalMpris.Player, track_key: Accessor<string>) {
	const reported_length = createBinding(player, "length")
	const metadata = createBinding(player, "metadata")
	let current_track = track_key.peek()
	let known_length =
		duration_cache.get(current_track) ?? Math.max(0, player.length)
	return createComputed(() => {
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
}

export function MediaPlayer({ player }: { player: AstalMpris.Player }) {
	const title = createBinding(player, "title").as(
		(title) => title || "Untitled",
	)
	const artist = createBinding(player, "artist").as(
		(artist) => artist || "Unknown Artist",
	)
	const cover_art = createBinding(player, "coverArt")
	const art_url = createBinding(player, "artUrl")
	const cover_uri = createComputed(() => art_url() || cover_art() || "")
	const selected_cover = createComputed(() =>
		create_texture_accessor(cover_uri(), cover_size()),
	)
	const cover_texture = createComputed(() => selected_cover()())
	const has_cover_art = cover_texture.as((texture) => texture !== null)
	const text_max_width = 20
	const player_icon = createBinding(player, "entry").as(
		(entry) => entry || icons.fallback.audio,
	)
	const position = createBinding(player, "position")
	const track_id = createBinding(player, "trackid")
	const track_key = createComputed(
		() => `${track_id()}|${title()}|${art_url()}`,
	)
	const length = track_length(player, track_key)
	const has_length = length.as((duration) => duration > 0)
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
	const [pending_position, set_pending_position] = createState<number | null>(
		null,
	)
	const displayed_position = createComputed(
		() => pending_position() ?? normalized_position(),
	)
	const seek = debounce<[number]>(60, (value) => {
		const duration = length.peek()
		if (duration > 0) player.position = value * duration
	})
	let settle_timer: timer | null = null
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
	const preview_seek = (value: number) => {
		set_pending_position(value)
		seek.call(value)
		settle_timer?.cancel()
		settle_timer = timeout(1500, release_pending_position)
	}
	onCleanup(() => {
		seek.cancel()
		dispose_position()
		dispose_track()
		settle_timer?.cancel()
	})

	const play_icon = playback_status.as((status) =>
		status === PLAYING ? icons.mpris.playing : icons.mpris.paused,
	)
	const loop = loop_status.as(loop_descriptor)
	const cycle_loop = () => {
		const next = next_loop(player.loopStatus)
		if (next !== null) player.set_loop_status(next)
	}
	const cycle_shuffle = () => {
		const next = next_shuffle(player.shuffleStatus)
		if (next !== null) player.set_shuffle_status(next)
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
				paintable={cover_texture.as((texture) => texture as Gdk.Paintable)}
				contentFit={COVER}
				canShrink
			/>

			<box orientation={VERTICAL}>
				<box class="title horizontal">
					<label
						label={title}
						halign={START}
						wrap
						hexpand
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
					wrap
					vexpand
					ellipsize={Pango.EllipsizeMode.END}
					lines={3}
					maxWidthChars={text_max_width}
				/>
				<slider
					tooltipText={length.as((duration) =>
						duration > 0
							? `Duration: ${format_clock(duration)}`
							: "Duration unavailable",
					)}
					visible={has_length}
					sensitive={createComputed(() => can_seek() && has_length())}
					onChangeValue={({ value }) => preview_seek(value)}
					value={displayed_position}
				/>
				<box class="horizontal">
					<label
						hexpand
						class="position"
						halign={START}
						visible={has_length}
						label={position.as(format_clock)}
					/>
					<box hexpand halign={CENTER}>
						<button
							class={shuffle_status.as((status) =>
								status === ON ? "active" : "",
							)}
							onClicked={cycle_shuffle}
							visible={shuffle_status.as(
								(status) => status !== shuffle_unsupported,
							)}
						>
							<image iconName={icons.mpris.shuffle} useFallback />
						</button>
						<button
							onClicked={() => player.previous()}
							visible={can_go_previous}
						>
							<image iconName={icons.mpris.prev} useFallback />
						</button>
						<button
							class="play-pause"
							onClicked={() => player.play_pause()}
							visible={can_control}
						>
							<image iconName={play_icon} useFallback />
						</button>
						<button onClicked={() => player.next()} visible={can_go_next}>
							<image iconName={icons.mpris.next} useFallback />
						</button>
						<button
							class={loop_status.as((status) =>
								status !== NONE && status !== loop_unsupported ? "active" : "",
							)}
							tooltipText={loop.as((descriptor) => descriptor.tooltip)}
							onClicked={cycle_loop}
							visible={loop_status.as((status) => status !== loop_unsupported)}
						>
							<image
								iconName={loop.as((descriptor) => descriptor.icon)}
								useFallback
							/>
						</button>
					</box>
					<label
						class="length"
						hexpand
						halign={END}
						visible={has_length}
						label={remaining.as(format_clock)}
					/>
				</box>
			</box>
		</box>
	)
}
