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
import { duration, toggleClass, textureFromFile, textureFromUri, bashSync, toggleWindow } from "$lib/utils"
import { audio, brightness, hypr, media } from "$lib/services"

import options from "options"

const { bar, quicksettings } = options
const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit

const { EXCLUSIVE } = Astal.Exclusivity

const layout = createComputed(() => `${bar.position()}-${quicksettings.position()}` as Position)

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
				const invert = scheme.peek() === "dark" ? "light" : "dark"
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
	const cover = createBinding(player, "artUrl")
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

	const remaining = createComputed(() => Math.max(0, len() - pos()))

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
				paintable={cover.as(url => textureFromUri(url, 100, 100) as Gdk.Paintable)}
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
	const LAYOUT_MAP: Record<string, string> = {
		"english": "en", "russian": "ru", "hebrew": "he", "arabic": "ar", "chinese": "zh",
		"japanese": "ja", "korean": "ko", "french": "fr", "german": "de", "spanish": "es",
		"italian": "it", "portuguese": "pt", "dutch": "nl", "polish": "pl", "turkish": "tr",
		"greek": "el", "ukrainian": "uk", "czech": "cs", "slovak": "sk", "hungarian": "hu",
		"romanian": "ro", "bulgarian": "bg", "croatian": "hr", "serbian": "sr", "slovene": "sl",
		"latvian": "lv", "lithuanian": "lt", "estonian": "et", "finnish": "fi", "swedish": "sv",
		"norwegian": "no", "danish": "da", "icelandic": "is", "thai": "th", "vietnamese": "vi",
		"hindi": "hi", "bengali": "bn", "tamil": "ta", "telugu": "te", "urdu": "ur",
		"persian": "fa", "farsi": "fa", "malayalam": "ml", "malagasy": "mg", "malay": "ms",
		"swahili": "sw", "yoruba": "yo", "zulu": "zu", "amharic": "am", "mongolian": "mn",
		"khmer": "km", "lao": "lo", "burmese": "my", "welsh": "cy", "irish": "ga",
		"basque": "eu", "catalan": "ca", "galician": "gl", "albanian": "sq", "macedonian": "mk",
		"bosnian": "bs", "montenegrin": "cnr", "belarusian": "be", "azerbaijani": "az",
		"georgian": "ka", "armenian": "hy", "kazakh": "kk", "kyrgyz": "ky", "uzbek": "uz",
		"tajik": "tg", "turkmen": "tk", "pashto": "ps", "dari": "prs", "kurdish": "ku",
		"afrikaans": "af", "akan": "ak", "bambara": "bm", "berber": "ber", "chuvash": "cv",
		"esperanto": "eo", "ewe": "ee", "faroese": "fo", "filipino": "fil", "friulian": "fur",
		"fulah": "ff", "gagauz": "gag", "igbo": "ig", "ido": "io", "indonesian": "id",
		"inuktitut": "iu", "javanese": "jv", "kannada": "kn", "kanuri": "kr", "kashmiri": "ks",
		"kikuyu": "ki", "kinyarwanda": "rw", "komi": "kv", "maltese": "mt", "maori": "mi",
		"marathi": "mr", "northern": "se", "yakut": "sah", "abkhazian": "ab", "asturian": "ast",
		"avatime": "avt", "cherokee": "chr", "crimean": "crh", "dhivehi": "dv"
	}

	namespace State {

		function getLayout() {
			const output = bashSync("hyprctl devices")
			const lines = output.split('\n')
			const layouts: string[] = []

			for (const line of lines) {
				if (line.includes('active keymap:')) {
					const match = line.match(/active keymap:\s*(.+)/)
					if (match) {
						const fullLayout = match[1].trim()
						const firstWord = fullLayout.split(/[\s(]/)[0].toLowerCase()
						layouts.push(firstWord)
					}
				}
			}

			const layoutCounts = new Map<string, number>()
			layouts.forEach(layout => {
				layoutCounts.set(layout, (layoutCounts.get(layout) || 0) + 1)
			})

			let activeLayout = "us"
			if (layoutCounts.size > 1) {
				for (const [layout, count] of layoutCounts) {
					if (count === 1) {
						activeLayout = layout
						break
					}
				}
			} else if (layouts.length > 0) {
				activeLayout = layouts[0]
			}

			return LAYOUT_MAP[activeLayout] || "us"
		}

		export function CurrentLayout() {
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
