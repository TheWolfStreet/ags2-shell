// Finds the preferred media player and briefly shows the current track title.

import { createBinding, createComputed, createState, onCleanup, With } from "ags"
import { Gtk } from "ags/gtk4"
import { timeout, Timer } from "ags/time"

import AstalMpris from "gi://AstalMpris"
import Pango from "gi://Pango"

import { media } from "$service/astal"
import options from "options"
import { PanelButton } from "../PanelButton"

export function MediaIndicator() {
	const player = createPreferredPlayer()
	const { reveal, bindTrackTitle, onEnter, onLeave } = createMediaReveal()

	return (
		<box visible={player.as(value => value != null)}>
			<With value={player}>
				{currentPlayer => {
					if (!currentPlayer)
						return <box visible={false} />

					return (
						<PanelButton
							visible
							name="media"
							onClicked={() => {
								if (currentPlayer.get_playback_status() === AstalMpris.PlaybackStatus.PLAYING)
									currentPlayer.pause()
								else
									currentPlayer.play()
							}}
						>
							<box class="media-content">
								<Gtk.EventControllerMotion onLeave={onLeave} onEnter={onEnter} />
								<image valign={Gtk.Align.CENTER} iconName={createPlayerIcon(currentPlayer)} useFallback />
								<revealer
									transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
									revealChild={reveal}
									$={self => bindTrackTitle(self, currentPlayer)}
								>
									<label
										valign={Gtk.Align.CENTER}
										ellipsize={Pango.EllipsizeMode.END}
										maxWidthChars={45}
										label={createPlayerLabel(currentPlayer)}
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

function createPreferredPlayer() {
	const players = createBinding(media, "players")
	return createComputed(() => players().find(player => {
		return player.get_bus_name().includes(options.bar.media.preferred())
	}) || players()[0])
}

function createMediaReveal() {
	const [reveal, setReveal] = createState(false)
	let trackTime: Timer | undefined

	function cancelTrackTime() {
		trackTime?.cancel()
		trackTime = undefined
	}

	function hideRevealLater(revealer: Gtk.Revealer) {
		trackTime = timeout(options.notifications.dismiss.peek(), () => {
			if (!revealer.in_destruction()) setReveal(false)
			trackTime = undefined
		})
	}

	function bindTrackTitle(revealer: Gtk.Revealer, player: AstalMpris.Player) {
		let currentTitle = ""
		const connection = player.connect("notify::title", () => {
			const nextTitle = player.get_title()
			if (currentTitle === nextTitle) return

			currentTitle = nextTitle
			setReveal(true)
			cancelTrackTime()
			hideRevealLater(revealer)
		})
		onCleanup(() => player.disconnect(connection))
	}

	onCleanup(cancelTrackTime)
	return {
		reveal,
		bindTrackTitle,
		onEnter: () => {
			cancelTrackTime()
			setReveal(true)
		},
		onLeave: () => setReveal(false),
	}
}

function createPlayerLabel(player: AstalMpris.Player) {
	const title = createBinding(player, "title")
	const artist = createBinding(player, "artist")
	return createComputed(() => {
		const trackTitle = title() || "Untitled"
		return artist() ? `${trackTitle} - ${artist()}` : trackTitle
	})
}

function createPlayerIcon(player: AstalMpris.Player) {
	return createBinding(player, "entry").as(entry => entry || "audio-x-generic-symbolic")
}
