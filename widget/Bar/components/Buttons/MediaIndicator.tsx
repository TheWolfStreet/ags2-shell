import {
	createBinding,
	createComputed,
	createState,
	onCleanup,
	With,
} from "ags"
import { Gtk } from "ags/gtk4"
import { timeout, type Timer } from "$lib/time"

import AstalMpris from "gi://AstalMpris"
import Pango from "gi://Pango"

import options from "$shell/options"
import { PanelButton } from "../PanelButton"

const media = AstalMpris.get_default()

export function MediaIndicator() {
	const player = create_preferred_player()
	const { reveal, bind_track_title, on_enter, on_leave } = create_media_reveal()

	return (
		<box visible={player.as((value) => value != null)}>
			<With value={player}>
				{(current_player) => {
					if (!current_player) return <box visible={false} />

					return (
						<PanelButton
							visible
							class="media"
							onClicked={() => {
								if (
									current_player.get_playback_status() ===
									AstalMpris.PlaybackStatus.PLAYING
								)
									current_player.pause()
								else current_player.play()
							}}
						>
							<box class="media-content">
								<Gtk.EventControllerMotion
									onLeave={on_leave}
									onEnter={on_enter}
								/>
								<image
									valign={Gtk.Align.CENTER}
									iconName={create_player_icon(current_player)}
									useFallback
								/>
								<revealer
									transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
									revealChild={reveal}
									$={(self) => bind_track_title(self, current_player)}
								>
									<label
										valign={Gtk.Align.CENTER}
										ellipsize={Pango.EllipsizeMode.END}
										singleLineMode
										maxWidthChars={45}
										label={create_player_label(current_player)}
									/>
								</revealer>
							</box>
						</PanelButton>
					)
				}}
			</With>
		</box>
	)
}

function create_preferred_player() {
	const players = createBinding(media, "players")
	return createComputed(() => {
		const available = players()
		return (
			available.find((player) =>
				player.get_bus_name().includes(options.bar.media.preferred()),
			) ?? available[0]
		)
	})
}

function create_media_reveal() {
	const [reveal, set_reveal] = createState(false)
	let track_time: Timer | undefined

	function cancel_track_time() {
		track_time?.cancel()
		track_time = undefined
	}

	function hide_reveal_later(revealer: Gtk.Revealer) {
		track_time = timeout(options.notifications.dismiss.peek(), () => {
			if (!revealer.in_destruction()) set_reveal(false)
			track_time = undefined
		})
	}

	function bind_track_title(revealer: Gtk.Revealer, player: AstalMpris.Player) {
		let current_title = ""
		const connection = player.connect("notify::title", () => {
			const next_title = player.get_title()
			if (current_title === next_title) return

			current_title = next_title
			set_reveal(true)
			cancel_track_time()
			hide_reveal_later(revealer)
		})
		onCleanup(() => {
			player.disconnect(connection)
			cancel_track_time()
			set_reveal(false)
		})
	}

	onCleanup(cancel_track_time)
	return {
		reveal,
		bind_track_title,
		on_enter: () => {
			cancel_track_time()
			set_reveal(true)
		},
		on_leave: () => set_reveal(false),
	}
}

function create_player_label(player: AstalMpris.Player) {
	const title = createBinding(player, "title")
	const artist = createBinding(player, "artist")
	return createComputed(() => {
		const track_title = title() || "Untitled"
		return artist() ? `${artist()} - ${track_title}` : track_title
	})
}

function create_player_icon(player: AstalMpris.Player) {
	return createBinding(player, "entry").as(
		(entry) => entry || "audio-x-generic-symbolic",
	)
}
