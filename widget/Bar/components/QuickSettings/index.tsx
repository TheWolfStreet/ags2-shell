import app from "ags/gtk4/app"
import { Accessor, createBinding, createComputed, createState, For, Node } from "ags"
import { monitorFile } from "ags/file"
import { Astal, Gdk, Gtk } from "ags/gtk4"

import AstalMpris from "gi://AstalMpris"

import { Settings } from "widget/Settings"
import { PanelButton } from "widget/Bar/components/PanelButton"
import { PopupWindow, Position } from "widget/shared/PopupWindow"
import { Network } from "./components/Network"
import { Audio } from "./components/Audio"
import { SimpleToggleButton } from "./components/shared/MenuElements"
import { DND } from "./components/DND"
import { Bluetooth } from "./components/Bluetooth"
import { Mirror } from "./components/Mirror"
import { Profiles } from "./components/PowerProfiles"

import env from "$lib/env"
import icons from "$lib/icons"
import { duration, toggleClass, textureFromFile, bashSync, toggleWindow } from "$lib/utils"
import { audio, brightness, hypr, media } from "$lib/services"

import options from "options"

const { bar, quicksettings } = options
const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit

const { EXCLUSIVE } = Astal.Exclusivity

const layout = createComputed([bar.position, quicksettings.position], (bar, qs) => `${bar}-${qs}` as Position)

const { scheme } = options.theme

namespace Sliders {
	export function Brightness() {
		let prevBrightness = 1
		return (
			<box class="control-unit" visible={createBinding(brightness, "displayAvailable")}>
				<button
					valign={CENTER}
					onClicked={() => {
						if (brightness.display > 0) {
							prevBrightness = brightness.display
							brightness.display = 0
						} else {
							brightness.display = prevBrightness
						}
					}}
					tooltipText={createBinding(brightness, "display").as(v => `Screen Brightness: ${Math.floor(v * 100)}% `)}
				>
					<image iconName={createBinding(brightness, "iconName")} useFallback />
				</button>
				<slider
					drawValue={false}
					hexpand
					value={createBinding(brightness, "display")}
					onNotifyValue={({ value }) => {
						brightness.display = value
					}}
				/>
			</box>
		)
	}
}

function DarkModeToggle() {
	return (
		<SimpleToggleButton
			// @ts-ignore: Valid keys
			iconName={scheme.as((s: string) => icons.color[s])}
			label={scheme.as(s => s === "dark" ? "Dark" : "Light")}
			toggle={() => {
				const invert = scheme.get() === "dark" ? "light" : "dark"
				scheme.set(invert)
			}}
			connection={scheme.as(s => s === "dark")}
		/>
	)
}

function MediaPlayer({ player }: { player: AstalMpris.Player }) {
	const { PLAYING } = AstalMpris.PlaybackStatus
	const { PLAYLIST, TRACK, NONE } = AstalMpris.Loop
	const { ON, OFF } = AstalMpris.Shuffle

	const title = createBinding(player, "title").as(t => t || "Untitled")
	const artist = createBinding(player, "artist").as(a => a || "Unknown Artist")
	// TODO: Handle weird mpv format
	const cover = createBinding(player, "coverArt")
	const icon = createBinding(player, "entry").as(e => e || "audio-x-generic-symbolic")
	const posNorm = createBinding(player, "position").as(p => player.length > 0 ? p / player.length : 0)
	const pos = createBinding(player, "position")
	const status = createBinding(player, "playbackStatus")
	const loop = createBinding(player, "loopStatus")
	const shuffle = createBinding(player, "shuffleStatus")
	const len = createBinding(player, "length")
	const control = createBinding(player, "canControl")
	const next = createBinding(player, "canGoNext")
	const prev = createBinding(player, "canGoPrevious")

	const remaining = createComputed([pos, len], (p, l) => Math.max(0, l - p))

	const playIcon = status.as(s => s === PLAYING ? icons.mpris.playing : icons.mpris.paused)
	const loopIcon = loop.as(s => {
		switch (s) {
			case NONE: return icons.mpris.loop.none
			case TRACK: return icons.mpris.loop.track
			case PLAYLIST: return icons.mpris.loop.playlist
			default: return icons.mpris.loop.none
		}
	})
	const loopHint = createBinding(player, "loopStatus").as((v) => {
		switch (v) {
			case NONE: return "Loop: Disabled"
			case PLAYLIST: return "Loop: Playlist"
			case TRACK: return "Loop: Track"
			default: return "Loop: Disabled"
		}
	})

	function cycleLoop(self: Gtk.Widget) {
		switch (player.loopStatus) {
			case NONE: player.set_loop_status(PLAYLIST); break
			case PLAYLIST: player.set_loop_status(TRACK); break
			case TRACK: player.set_loop_status(NONE); break
			default: toggleClass(self, "active", false); break
		}
	}

	function cycleShuffle(self: Gtk.Widget) {
		switch (player.shuffleStatus) {
			case OFF: player.set_shuffle_status(ON); toggleClass(self, "active", true); break
			case ON: player.set_shuffle_status(OFF); toggleClass(self, "active", false); break
			default: toggleClass(self, "active", false); break
		}
	}
	let lastUpdate = 0

	return (
		<box class="player" vexpand={false}>
			<Gtk.Picture
				class="cover-art"
				// FIXME: Make it cover, not resize
				paintable={cover.as(url => textureFromFile(url, 100, 100) as Gdk.Paintable)}
				contentFit={COVER}
			/>

			<box orientation={VERTICAL}>
				<box class="title horizontal">
					<label
						label={title}
						halign={START}
						wrap hexpand
						maxWidthChars={20}
					/>
					<image iconName={icon} useFallback />
				</box>
				<label
					class="artist"
					label={artist}
					halign={START}
					valign={START}
					wrap vexpand
					maxWidthChars={20}
				/>
				<slider
					tooltipText={len.as(v => (v > 0) ? `Duration: ${duration(v)}` : "")}
					visible={len.as(l => l > 0)}
					onNotifyValue={({ value }) => {
						const now = Date.now()
						if (now - lastUpdate < 100) return
						lastUpdate = now
						player.position = value * player.length
					}}
					value={posNorm}
				/>
				<box class="horizontal">
					<label
						hexpand
						class="position"
						halign={START}
						visible={len.as(l => l > 0)}
						label={pos.as(duration)}
					/>
					<box>
						<button
							onClicked={cycleShuffle}
							visible={shuffle.as(s => s != AstalMpris.Shuffle.UNSUPPORTED)}>
							<image iconName={icons.mpris.shuffle} useFallback />
						</button>
						<button onClicked={() => player.previous()} visible={prev}>
							<image iconName={icons.mpris.prev} useFallback />
						</button>
						<button class="play-pause" onClicked={() => player.play_pause()} visible={control}>
							<image iconName={playIcon} useFallback />
						</button>
						<button onClicked={() => player.next()} visible={next}>
							<image iconName={icons.mpris.next} useFallback />
						</button>
						<button
							tooltipText={loopHint}
							onClicked={cycleLoop}
							visible={loop.as(s => s != AstalMpris.Loop.UNSUPPORTED)}
						>
							<image iconName={loopIcon} useFallback />
						</button>
					</box>
					<label
						class="length"
						hexpand
						halign={END}
						visible={len.as(l => l > 0)}
						label={remaining.as(duration)}
					/>
				</box>
			</box>
		</box>
	)
}

export namespace QuickSettings {
	namespace State {
		const ISO639 = {
			"abkh": "ab",		// Abkhazian
			"astu": "ast",	// Asturian
			"avat": "avt",	// Avatime
			"akan": "ak",		// Akan
			"alba": "sq",		// Albanian
			"arme": "hy",		// Armenian
			"bamb": "bm",		// Bambara
			"banb": "bn",		// Bangla
			"berb": "ber",	// Berber
			"bosn": "bs",		// Bosnian
			"bulg": "bg",		// Bulgarian
			"burm": "my",		// Burmese
			"cher": "chr",	// Cherokee
			"chin": "zh",		// Chinese
			"chuv": "cv",		// Chuvash
			"crim": "crh",	// Crimean Tatar
			"croa": "hr",		// Croatian
			"czec": "cs",		// Czech
			"dari": "prs",	// Dari
			"dhiv": "dv",		// Dhivehi
			"dutc": "nl",		// Dutch
			"esper": "eo",	// Esperanto
			"esto": "et",		// Estonian
			"ewe": "ee",		// Ewe
			"faro": "fo",		// Faroese
			"fili": "fil",  // Filipino
			"friu": "fur",	// Friulian
			"fula": "ff",		// Fulah
			"ga": "gaa",		// Ga
			"gaga": "gag",	// Gagauz
			"geor": "ka",		// Georgian
			"germ": "de",		// German
			"gree": "el",		// Greek
			"igbo": "ig",		// Igbo
			"icel": "is",		// Icelandic
			"ido": "io",		// Ido
			"indo": "id",		// Indonesian
			"inuk": "iu",		// Inuktitut
			"iris": "ga",		// Irish
			"java": "jv",		// Javanese
			"kann": "kn",		// Kannada
			"kanu": "kr",		// Kanuri
			"kash": "ks",		// Kashmiri
			"kaza": "kk",		// Kazakh
			"khme": "km",		// Khmer
			"kiku": "ki",		// Kikuyu
			"kiny": "rw",		// Kinyarwanda
			"kirg": "ky",		// Kirghiz
			"komi": "kv",		// Komi
			"kurd": "ku",		// Kurdish
			"lao": "lo",		// Lao
			"latv": "lv",		// Latvian
			"lith": "lt",		// Lithuanian
			"mace": "mk",		// Macedonian
			"malt": "mt",		// Maltese
			"maor": "mi",		// Maori
			"mara": "mr",		// Marathi
			"mong": "mn",		// Mongolian
			"nort": "se",		// Northern Sami
			"port": "pt",		// Portuguese
			"yaku": "sah",	// Yakut
		}

		export function CurrentLayout() {
			function getLayout() {
				const layout = bashSync("hyprctl devices | awk '/active keymap:/{a[$3]++} END{min=NR; for(layout in a) if(a[layout]<min){min=a[layout]; minlayout=layout} print minlayout}'")
					.toLowerCase()

				if (layout == "malagasy") return "mg"
				if (layout == "malay") return "ms"
				if (layout == "malayalam") return "ml"

				// @ts-ignore: Valid keys
				return ISO639[layout.slice(0, 4)] || layout.slice(0, 2)
			}

			const [layout, set_layout] = createState(getLayout())
			hypr.connect("keyboard-layout", () => set_layout(getLayout()))
			return <label label={layout} />
		}
	}

	export function Button() {
		return (
			<PanelButton
				name="quicksettings"
				onClicked={() => toggleWindow("quicksettings")}
			>
				<Gtk.EventControllerScroll
					flags={Gtk.EventControllerScrollFlags.VERTICAL}
					onScroll={(_: any, __: number, dy: number) => {
						const spkr = audio?.get_default_speaker()
						if (spkr) {
							const current = spkr.get_volume() ?? 0
							spkr.set_volume(Math.min(1, Math.max(0, current - dy * 0.025)))
						}
						return true
					}}
				/>
				<Gtk.GestureClick
					button={0}
					onPressed={self => {
						const mBtn = self.get_current_button()
						switch (mBtn) {
							case Gdk.BUTTON_MIDDLE:
								const spkr = audio?.get_default_speaker()
								if (spkr) {
									spkr.set_mute(!spkr.get_mute())
								}
								break
							default:
								break
						}
						self.reset()
					}}
				/>
				<box class="horizontal">
					<State.CurrentLayout />
					<Profiles.State.Power />
					<Network.State />
					<Bluetooth.State />
					<Profiles.State.Asus />
					<Audio.State.Speaker />
					<Audio.State.Microphone />
					<DND.State />
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		function Row({
			toggles = [],
			menus = [],
		}: {
			toggles?: Array<() => JSX.Element>
			menus?: Array<() => JSX.Element>
		} = {}) {
			return (
				<box orientation={VERTICAL}>
					<box class="row horizontal" homogeneous>
						{toggles.map(Toggle => Toggle())}
					</box>
					{menus.map(Menu => Menu())}
				</box>
			)
		}

		const Header = () =>
			<box class="header horizontal">
				<Gtk.Picture
					class="avatar"
					$={self => {
						monitorFile(env.paths.avatar, () => {
							self.paintable = textureFromFile(env.paths.avatar, 64, 64) as Gdk.Paintable
						})
					}}
					paintable={textureFromFile(env.paths.avatar, 64, 64) as Gdk.Paintable}
					contentFit={COVER}
					canShrink
				/>
				<box orientation={VERTICAL} valign={CENTER}>
					<box>
						<label class="username" label={env.username} />
					</box>
				</box>
				<box hexpand />
				<Settings.Button />
			</box >

		return (
			<PopupWindow
				name="quicksettings"
				exclusivity={EXCLUSIVE}
				application={app}
				layout={layout}
			>
				<box class="quicksettings vertical"
					css={quicksettings.width.as((w: any) => `min-width: ${w}px;`)}
					orientation={VERTICAL}>
					<Header />
					<box class="sliders-box vertical" orientation={VERTICAL}>
						<Row
							toggles={[Audio.Sliders.Volume]}
							menus={[Audio.SinkSelector, Audio.AppMixer]}
						/>
						<Audio.Sliders.Microphone />
						<Sliders.Brightness />
					</box>
					<Row
						toggles={[Network.Wifi.Toggle, Bluetooth.Toggle]}
						menus={[Network.Wifi.Selector, Bluetooth.Selector]}
					/>
					<Row toggles={[DarkModeToggle, DND.Toggle]} />
					<Row toggles={[Profiles.Toggle, Mirror.Toggle]} menus={[Profiles.Selector, Mirror.Selector]} />
					<box
						class="media vertical"
						visible={createBinding(media, "players").as(players => players.length > 0)}
						orientation={VERTICAL}
					>
						<For each={createBinding(media, "players")}>
							{(player: AstalMpris.Player) => <MediaPlayer player={player} />}
						</For>
					</box>
				</box>
			</PopupWindow>
		)
	}
}
