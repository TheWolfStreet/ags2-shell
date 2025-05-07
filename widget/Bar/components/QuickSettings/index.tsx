import Astal from "gi://Astal"
import Mpris from "gi://AstalMpris"

import { bind, Binding, Variable } from "astal"
import { App, Gtk } from "astal/gtk3"

import PopupWindow from "../../../PopupWindow"
import { BtSelector, BtToggle, DarkModeToggle, DNDToggle, WifiToggle, WifiSelector, ProfileToggle, ProfileSelector, Microphone, AppMixer, Volume, SinkSelector, MirrorToggle, MirrorSelector } from "./components/Toggles"

import icons from "../../../../lib/icons"
import { env } from "../../../../lib/environment"
import { brightness, media, } from "../../../../lib/services"
import { duration, } from "../../../../lib/utils"
import options from "../../../../options"

const { bar, quicksettings } = options
const { START, CENTER, END } = Gtk.Align
const { SLIDE_DOWN, SLIDE_UP } = Gtk.RevealerTransitionType

const layout = Variable.derive([bar.position, quicksettings.position], (bar, qs) => `${bar}-${qs}` as const)

function MediaPlayer({ player }: { player: Mpris.Player }) {
	const { PLAYING } = Mpris.PlaybackStatus
	const { PLAYLIST, TRACK, NONE } = Mpris.Loop
	const { ON, OFF } = Mpris.Shuffle

	const title = bind(player, "title").as(t =>
		t || "Untitled")

	const artist = bind(player, "artist").as(a =>
		a || "Unknown Artist")

	const coverArt = bind(player, "coverArt").as(c =>
		`background-image: url('${c}');`)

	const playerIcon = bind(player, "entry").as(e =>
		e && Astal.Icon.lookup_icon(e) ? e : "audio-x-generic-symbolic"
	)

	const position = bind(player, "position").as(p => player.length > 0
		? p / player.length : 0)

	const playIcon = bind(player, "playbackStatus").as(s =>
		s === PLAYING
			? icons.mpris.playing
			: icons.mpris.paused
	)

	const loopIcon = bind(player, "loopStatus").as(s => {
		switch (s) {
			case NONE:
				return icons.mpris.loop.none
			case TRACK:
				return icons.mpris.loop.track
			case PLAYLIST:
				return icons.mpris.loop.playlist
			default: break
		}
	})

	const shuffleIcon = bind(player, "shuffleStatus").as(s => {
		switch (s) {
			case ON:
				return icons.mpris.shuffle
			case OFF:
				return icons.mpris.shuffle
			default: break
		}
	})

	return (
		<box className="player" vexpand={false}>
			<box className="cover-art" css={coverArt} />
			<box vertical>
				<box className="title horizontal">
					<label wrap hexpand halign={START} label={title} maxWidthChars={20} />
					<icon icon={playerIcon} useFallback />
				</box>
				<label className="artist" halign={START} valign={START} vexpand wrap label={artist} maxWidthChars={20} />
				<slider
					visible={bind(player, "length").as(l => l > 0)}
					onDragged={({ value }) => player.position = value * player.length}
					value={position}
				/>
				<centerbox className="footer horizontal">
					<label
						hexpand
						className="position"
						halign={START}
						visible={bind(player, "length").as(l => l > 0)}
						label={bind(player, "position").as(duration)}
					/>
					<box>
						{/* NOTE: This does not work at the moment */}
						<button
							onClicked={(self) => {
								switch (player.shuffleStatus) {
									case ON:
										player.set_shuffle_status(ON)
										self.toggleClassName("active")
										break
									case OFF:
										player.set_shuffle_status(OFF)
										self.toggleClassName("active", false)
										break
									default:
										self.toggleClassName("active", false)
										break
								}
							}}
							visible={false}>
							<icon icon={shuffleIcon} useFallback />
						</button>
						<button
							onClicked={() => player.previous()}
							visible={bind(player, "canGoPrevious")}>
							<icon icon={icons.mpris.prev} useFallback />
						</button>
						<button
							className="play-pause"
							onClicked={() => player.play_pause()}
							visible={bind(player, "canControl")}>
							<icon icon={playIcon} useFallback />
						</button>
						<button
							onClicked={() => player.next()}
							visible={bind(player, "canGoNext")}>
							<icon icon={icons.mpris.next} useFallback />
						</button>
						<button
							onClicked={(self) => {
								switch (player.loopStatus) {
									case NONE:
										player.set_loop_status(PLAYLIST)
										self.toggleClassName("active")
										break
									case PLAYLIST:
										player.set_loop_status(TRACK)
										self.toggleClassName("active")
										break
									case TRACK:
										player.set_loop_status(NONE)
										self.toggleClassName("active", false)
										break
									default:
										self.toggleClassName("active", false)
										break
								}
							}}
							visible={bind(player, "loopStatus").as(s => s != Mpris.Loop.UNSUPPORTED)}>
							<icon icon={loopIcon} useFallback />
						</button>
					</box>
					<label
						className="length"
						hexpand
						halign={END}
						visible={bind(player, "length").as(l => l > 0)}
						label={bind(player, "length").as(l => l > 0 ? duration(l) : "0:00")}
					/>
				</centerbox>
			</box>
		</box>
	)
}

function Brightness() {
	let prevBrightness = 1
	return (
		<box className="brightness" visible={bind(brightness, "displayAvailable")}>
			<button
				valign={CENTER}
				onClick={() => {
					if (brightness.display > 0) {
						prevBrightness = brightness.display
						brightness.display = 0
					} else {
						brightness.display = prevBrightness
					}
				}}
				tooltipText={bind(brightness, "display").as((v) => {
					return `Screen Brightness: ${Math.floor(v * 100)}% `
				})}
			>
				<icon icon={bind(brightness, "displayIcon")} useFallback></icon>
			</button>
			<slider
				drawValue={false}
				hexpand
				value={bind(brightness, "display")}
				onDragged={({ value }) => {
					brightness.display = value
				}}
			/>
		</box>
	)
}

function QuickSettings() {
	const Header = () =>
		<box className="header horizontal">
			<box
				className="avatar"
				css={`background-image: url('${env.paths.avatar}');`}
			/>
			<box vertical valign={CENTER}>
				<box>
					<label className="username" label={env.username} />
				</box>
			</box>
			<box hexpand />
			<button
				valign={CENTER}
				onClick={() => {
					const settings = App.get_window("settings-dialog")
					const qsettings = App.get_window("quicksettings")

					if (!settings?.visible) {
						settings?.show()
					} else {
						settings.hide()
						settings.show()
					}
					qsettings?.close()
				}}
			>
				<icon icon={icons.ui.settings} useFallback />
			</button>
		</box >

	const Row = (params: {
		toggles?: Array<() => Gtk.Widget>,
		menus?: Array<() => Gtk.Widget | Binding<Gtk.Widget>>;
	} = { toggles: [], menus: [] }) => {
		const { toggles = [], menus = [] } = params

		return (
			<box vertical>
				<box className="row horizontal" homogeneous>
					{toggles.map(w => w())}
				</box>
				{...menus.map(w => w())}
			</box>
		)
	}

	return (
		<PopupWindow
			name="quicksettings"
			exclusivity={Astal.Exclusivity.EXCLUSIVE}
			transitionType={options.bar.position(pos => pos === "top" ? SLIDE_DOWN : SLIDE_UP)}
			layout={layout.get()}
		>
			<box className="quicksettings vertical"
				css={quicksettings.width(w => `min-width: ${w}px;`)}
				vertical >
				<Header />
				<box className="sliders-box vertical" vertical>
					<Row
						toggles={[Volume]}
						menus={[SinkSelector, AppMixer]}
					/>
					<Microphone />
					<Brightness />
				</box>
				<Row
					toggles={[WifiToggle, BtToggle]}
					menus={[WifiSelector, BtSelector]}
				/>
				<Row toggles={[DarkModeToggle, DNDToggle]} />
				<Row toggles={[ProfileToggle, MirrorToggle]} menus={[ProfileSelector, MirrorSelector]} />
				<box className="media vertical" visible={bind(media, "players").as((players) => players.length > 0)} vertical>
					{bind(media, "players").as(ps => ps.map(p => <MediaPlayer player={p} />))}
				</box>
			</box>
		</PopupWindow>
	)
}

export default function setupQuickSettings() {
	App.add_window(QuickSettings() as Gtk.Window)
	layout.subscribe(() => {
		(QuickSettings() as Gtk.Window).close()
		App.remove_window(QuickSettings() as Gtk.Window)
		App.add_window(QuickSettings() as Gtk.Window)
	});
}
