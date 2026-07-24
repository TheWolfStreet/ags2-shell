// Shows track details, artwork, buttons, and progress and handles seeking.

import { Gdk, Gtk } from "ags/gtk4"

import { createBinding, createComputed, createState, onCleanup } from "ags"
import { timeout, type Timer } from "ags/time"

import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"

import icons from "$lib/icons"
import { formatClock } from "$lib/time"
import { createSquareTextureAccessor } from "$lib/textures"
import { debounce } from "$lib/timing"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit
const durationCache = new Map<string, number>()
const DURATION_CACHE_LIMIT = 64

function rememberDuration(track: string, duration: number) {
	if (durationCache.has(track)) durationCache.delete(track)
	durationCache.set(track, duration)
	if (durationCache.size > DURATION_CACHE_LIMIT) {
		const oldest = durationCache.keys().next().value
		if (oldest) durationCache.delete(oldest)
	}
}

function metadataLength(metadata: GLib.Variant) {
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
	const coverArt = createBinding(player, "coverArt")
	const artUrl = createBinding(player, "artUrl")
	const coverUri = createComputed(() => coverArt() || artUrl() || "")
	const coverTexture = createComputed(() => createSquareTextureAccessor(coverUri(), 100)())
	const hasCoverArt = coverTexture.as(texture => texture !== null)
	const textMaxWidth = 20
	const playerIcon = createBinding(player, "entry").as(entry => entry || "audio-x-generic-symbolic")
	const position = createBinding(player, "position")
	const reportedLength = createBinding(player, "length")
	const metadata = createBinding(player, "metadata")
	const trackId = createBinding(player, "trackid")
	const trackKey = createComputed(() => `${trackId()}|${title()}|${artUrl()}`)
	let currentTrack = trackKey.peek()
	let knownLength = durationCache.get(currentTrack) ?? Math.max(0, player.length)
	const length = createComputed(() => {
		const nextTrack = trackKey()
		if (nextTrack !== currentTrack) {
			currentTrack = nextTrack
			knownLength = durationCache.get(currentTrack) ?? 0
		}
		const duration = Math.max(reportedLength(), metadataLength(metadata()))
		if (duration > 0) {
			knownLength = duration
			rememberDuration(currentTrack, duration)
		}
		return knownLength
	})
	const normalizedPosition = createComputed(() => {
		const duration = length()
		return duration > 0 ? Math.min(1, Math.max(0, position()) / duration) : 0
	})
	const playbackStatus = createBinding(player, "playbackStatus")
	const loopStatus = createBinding(player, "loopStatus")
	const shuffleStatus = createBinding(player, "shuffleStatus")
	const canControl = createBinding(player, "canControl")
	const canGoNext = createBinding(player, "canGoNext")
	const canGoPrevious = createBinding(player, "canGoPrevious")
	const canSeek = createBinding(player, "canSeek")

	const remaining = createComputed(() => Math.max(0, length() - position()))
	const [pendingPosition, setPendingPosition] = createState<number | null>(null)
	const displayedPosition = createComputed(() => pendingPosition() ?? normalizedPosition())
	const seek = debounce<[number]>(60, value => {
		const duration = length.peek()
		if (duration > 0) player.position = value * duration
	})
	let settleTimer: Timer | null = null
	const releasePendingPosition = () => {
		settleTimer?.cancel()
		settleTimer = null
		setPendingPosition(null)
	}
	const disposePosition = normalizedPosition.subscribe(() => {
		const value = normalizedPosition.peek()
		const pending = pendingPosition.peek()
		if (pending !== null && Math.abs(value - pending) < 0.02)
			releasePendingPosition()
	})
	const disposeTrack = trackKey.subscribe(releasePendingPosition)
	onCleanup(() => {
		seek.cancel()
		disposePosition()
		disposeTrack()
		settleTimer?.cancel()
	})

	const playIcon = playbackStatus.as(status => status === PLAYING ? icons.mpris.playing : icons.mpris.paused)
	const loopDescriptor = loopStatus.as(status => {
		switch (status) {
			case NONE: return { icon: icons.mpris.loop.none, tooltip: "Loop: Disabled" }
			case TRACK: return { icon: icons.mpris.loop.track, tooltip: "Loop: Track" }
			case PLAYLIST: return { icon: icons.mpris.loop.playlist, tooltip: "Loop: Playlist" }
			default: return { icon: icons.mpris.loop.none, tooltip: "Loop: Disabled" }
		}
	})

	function cycleLoop() {
		switch (player.loopStatus) {
			case NONE: player.set_loop_status(PLAYLIST); break
			case PLAYLIST: player.set_loop_status(TRACK); break
			case TRACK: player.set_loop_status(NONE); break
			default: break
		}
	}

	function cycleShuffle() {
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
				visible={hasCoverArt}
				widthRequest={100}
				heightRequest={100}
				halign={CENTER}
				valign={CENTER}
				paintable={coverTexture.as(texture => texture as Gdk.Paintable)}
				contentFit={COVER}
			/>

			<box orientation={VERTICAL}>
				<box class="title horizontal">
					<label
						label={title}
						halign={START}
						wrap hexpand
						maxWidthChars={textMaxWidth}
					/>
					<image iconName={playerIcon} useFallback />
				</box>
				<label
					class="artist"
					label={artist}
					halign={START}
					valign={START}
					wrap vexpand
					maxWidthChars={textMaxWidth}
				/>
				<slider
					tooltipText={length.as(duration => duration > 0 ? `Duration: ${formatClock(duration)}` : "Duration unavailable")}
					visible={length.as(duration => duration > 0)}
					sensitive={createComputed(() => canSeek() && length() > 0)}
					onChangeValue={({ value }) => {
						setPendingPosition(value)
						seek.call(value)
						settleTimer?.cancel()
						settleTimer = timeout(1500, releasePendingPosition)
					}}
					value={displayedPosition}
				/>
				<box class="horizontal">
					<label
						hexpand
						class="position"
						halign={START}
						visible={length.as(duration => duration > 0)}
						label={position.as(formatClock)}
					/>
					<box hexpand halign={CENTER}>
						<button
							class={shuffleStatus.as(status => status === ON ? "active" : "")}
							onClicked={cycleShuffle}
							visible={shuffleStatus.as(status => status != AstalMpris.Shuffle.UNSUPPORTED)}>
							<image iconName={icons.mpris.shuffle} useFallback />
						</button>
						<button onClicked={() => player.previous()} visible={canGoPrevious}>
							<image iconName={icons.mpris.prev} useFallback />
						</button>
						<button class="play-pause" onClicked={() => player.play_pause()} visible={canControl}>
							<image iconName={playIcon} useFallback />
						</button>
						<button onClicked={() => player.next()} visible={canGoNext}>
							<image iconName={icons.mpris.next} useFallback />
						</button>
						<button
							class={loopStatus.as(status => status !== NONE && status !== AstalMpris.Loop.UNSUPPORTED ? "active" : "")}
							tooltipText={loopDescriptor.as(descriptor => descriptor.tooltip)}
							onClicked={cycleLoop}
							visible={loopStatus.as(status => status != AstalMpris.Loop.UNSUPPORTED)}
						>
							<image iconName={loopDescriptor.as(descriptor => descriptor.icon)} useFallback />
						</button>
					</box>
					<label
						class="length"
						hexpand
						halign={END}
						visible={length.as(duration => duration > 0)}
						label={remaining.as(formatClock)}
					/>
				</box>
			</box>
		</box>
	)
}
