import Astal from "gi://Astal"
import Mpris from "gi://AstalMpris"
import Network from "gi://AstalNetwork"
import { bind, Binding, Variable } from "astal"
import { App, Gtk, Widget } from "astal/gtk3"

import PopupWindow from "../../../PopupWindow"
import { BtSelector, BtToggle, DarkModeToggle, DNDToggle, WifiToggle, WifiSelector, ProfileToggle, ProfileSelector, Microphone, AppMixer, Volume, SinkSelector, ProjectToggle, ProjectSelector } from "./components/Toggles"
import PanelButton from "../PanelButton"

import icons from "../../../../lib/icons"
import { env } from "../../../../lib/environment"
import { asusctl, audio, brightness, bt, hypr, media, net, notifd, pp } from "../../../../lib/services"
import { bashSync, duration, onWindowToggle, toggleWindow } from "../../../../lib/utils"
import options from "../../../../options"

const { bar, quicksettings } = options
const { WIRED, WIFI } = Network.Primary
const { START, CENTER, END } = Gtk.Align
const { SLIDE_DOWN, SLIDE_UP } = Gtk.RevealerTransitionType

const layout = Variable.derive([bar.position, quicksettings.position], (bar, qs) => `${bar}-${qs}` as const)

function ProfileState() {
	const visible = asusctl.available
		? bind(asusctl, "profile").as(p => p !== "Balanced")
		: bind(pp, "active_profile").as(p => p !== "balanced")

	const icon = asusctl.available
		? bind(asusctl, "profile").as((p: "Performance" | "Balanced" | "Quiet") => icons.asusctl.profile[p])
		: bind(pp, "active_profile").as((p: string) => icons.powerprofile[p as "balanced" | "power-saver" | "performance"])

	return <icon icon={icon} visible={visible} useFallback />
}

function ModeIndicator() {
	if (!asusctl.available) return <icon visible={false} useFallback />
	const mode = bind(asusctl, "mode")
	return (
		<icon
			icon={mode.as(m => icons.asusctl.mode[m])}
			visible={mode.as(m => m !== "Hybrid")}
			useFallback
		/>
	)
}

function CurrentLayout() {
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

	function getLayout() {
		const layout = bashSync("hyprctl devices | awk '/active keymap:/{a[$3]++} END{min=NR; for(layout in a) if(a[layout]<min){min=a[layout]; minlayout=layout} print minlayout}'")
			.toLowerCase()

		if (layout == "malagasy") return "mg"
		if (layout == "malay") return "ms"
		if (layout == "malayalam") return "ml"

		// @ts-ignore: Valid keys
		return ISO639[layout.slice(0, 4)] || layout.slice(0, 2)
	}

	const layout = Variable(getLayout())
	hypr.connect("keyboard-layout", () => layout.set(getLayout()))
	return <label label={layout()} />
}

function BtState() {
	const hasConnected = bind(bt, "isConnected")
	const isPowered = bind(bt, "isPowered")
	return (
		<box visible={isPowered}>
			<overlay
				className="bluetooth"
				passThrough
				child={<icon icon={icons.bluetooth.enabled} useFallback />}
				overlay={
					<box
						className="indicator"
						halign={CENTER}
						valign={START}
						visible={hasConnected}
					/>
				}
			/>
		</box>
	)
}

function NetworkState() {
	//TODO: Make dynamic based on presence of wifi adapter
	const icon = Variable.derive([bind(net, "primary"), net.wifi ? bind(net.wifi, "iconName") : Variable("")(), net.wired ? bind(net.wired, "iconName") : Variable("")],
		(type, wifi, wired) => {
			return type === WIFI ? wifi : (type === WIRED ? wired : "")
		})

	return (
		<icon
			icon={icon()}
			visible={icon(i => i !== "")}
			useFallback
		/>
	)
}

const DndState = () =>
	<icon
		icon={icons.notifications.silent}
		visible={bind(notifd, "dontDisturb")}
		useFallback
	/>


function MicState() {
	return audio ? <icon icon={bind(audio.defaultMicrophone, "volumeIcon")} useFallback /> : <box visible={false} />
}
function SpkrState() {
	return audio ? <icon icon={bind(audio.defaultSpeaker, "volumeIcon")} useFallback /> : <box visible={false} />
}

export const SysIndicators = () =>
	<PanelButton
		name="quicksettings"
		className="quicksettings"
		onClick={() => toggleWindow("quicksettings")}
		setup={self => {
			onWindowToggle(self, self.name, (w) => {
				self.toggleClassName("active", w.visible)
			})
		}}
		onScroll={(_: Widget.Button, event: Astal.ScrollEvent) => {
			const spkr = audio?.get_default_speaker()
			spkr?.set_volume((spkr.get_volume() ?? 0) - event.delta_y * 0.025)
		}}
	>
		<box className="horizontal">
			<CurrentLayout />
			<ProfileState />
			<ModeIndicator />
			<BtState />
			<NetworkState />
			<DndState />
			<SpkrState />
			<MicState />
		</box>
	</PanelButton>

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

function Row(params: {
	toggles?: Array<() => Gtk.Widget>,
	menus?: Array<() => Gtk.Widget | Binding<Gtk.Widget>>;
} = { toggles: [], menus: [] }) {
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

let prevBrightness = 1
const Brightness = () =>
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

const Settings = () =>
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
		<Row toggles={[ProfileToggle, ProjectToggle]} menus={[ProfileSelector, ProjectSelector]} />
		<box className="media vertical" visible={bind(media, "players").as((players) => players.length > 0)} vertical>
			{bind(media, "players").as(ps => ps.map(p => <MediaPlayer player={p} />))}
		</box>
	</box>

const QuickSettings = () =>
	<PopupWindow
		name="quicksettings"
		exclusivity={Astal.Exclusivity.EXCLUSIVE}
		transitionType={options.bar.position(pos => pos === "top" ? SLIDE_DOWN : SLIDE_UP)}
		layout={layout.get()}
	><Settings />
	</PopupWindow>

export default function setupQuickSettings() {
	App.add_window(QuickSettings() as Gtk.Window)
	layout.subscribe(() => {
		(QuickSettings() as Gtk.Window).close()
		App.remove_window(QuickSettings() as Gtk.Window)
		App.add_window(QuickSettings() as Gtk.Window)
	});
}
