import app from "ags/gtk4/app"
import { createBinding, createState, For } from "ags"
import { monitorFile } from "ags/file"
import { execAsync } from "ags/process"
import { Astal, Gdk, Gtk } from "ags/gtk4"

import AstalMpris from "gi://AstalMpris"

import { Settings } from "widget/Settings"
import { PanelButton } from "widget/Bar/components/PanelButton"
import { PopupWindow } from "widget/shared/PopupWindow"
import { Network } from "./components/Network"
import { Audio } from "./components/Audio"
import { ToggleButton } from "./components/shared/MenuElements"
import { DND } from "./components/DND"
import { Bluetooth } from "./components/Bluetooth"
import { Mirror } from "./components/Mirror"
import { Profiles } from "./components/PowerProfiles"

import env from "$lib/env"
import icons from "$lib/icons"
import { attemptAsync } from "$lib/result"
import { popupLayout, toggleWindow } from "$lib/utils"
import { textureFromFileSquareContain } from "$lib/textures"
import { audio, brightness, hypr, media } from "$lib/services"

import options from "options"

const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { VERTICAL: SCROLL_VERTICAL } = Gtk.EventControllerScrollFlags
const { COVER } = Gtk.ContentFit

const { EXCLUSIVE } = Astal.Exclusivity
const { BUTTON_MIDDLE } = Gdk

const { bar, quicksettings } = options
const { scheme } = options.theme

const layout = popupLayout(bar.position, quicksettings.position)

namespace Sliders {

	export function Brightness() {
		let prevBrightness = 1

		const toggleBrightnessMute = () => {
			if (brightness.display > 0) {
				prevBrightness = brightness.display
				brightness.display = 0
			} else {
				brightness.display = prevBrightness
			}
		}

		const display = createBinding(brightness, "display")

		return (
			<box class="control-unit" visible={createBinding(brightness, "displayAvailable")}>
				<button
					valign={CENTER}
					onClicked={toggleBrightnessMute}
					tooltipText={display.as(v => `Screen Brightness: ${Math.floor(v * 100)}% `)}
				>
					<image iconName={createBinding(brightness, "iconName")} useFallback />
				</button>
				<slider
					drawValue={false}
					hexpand
					value={display}
					onChangeValue={({ value }) => {
						brightness.display = value
					}}
				/>
			</box>
		)
	}
}
namespace DarkMode {
	export function Toggle() {
		const isDark = scheme.as(s => s === "dark")

		const toggleThemeScheme = () => {
			scheme.set(isDark.peek() ? "light" : "dark")
		}

		return (
			<ToggleButton
				iconName={isDark.as(dark => icons.color[dark ? "dark" : "light"])}
				label={isDark.as(dark => dark ? "Dark" : "Light")}
				toggle={toggleThemeScheme}
				connection={isDark}
			/>
		)
	}
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

	namespace Keyboard {
		async function getLayout(): Promise<string> {
			const result = await attemptAsync(async (): Promise<string> => {
				const output = (await execAsync("hyprctl devices -j")).trim()
				if (!output) return "err"
				const data = JSON.parse(output) as { keyboards?: Array<{ active_keymap?: string, main?: boolean }> }
				const keyboards = Array.isArray(data.keyboards) ? data.keyboards : []
				for (const keyboard of keyboards) {
					if (keyboard.main && typeof keyboard.active_keymap === "string" && keyboard.active_keymap.length > 0) {
						const keymap = keyboard.active_keymap.trim().split(/[\s(]/)[0].toLowerCase()
						return LAYOUT_MAP[keymap] || keymap
					}
				}
				return "unk"
			})
			if (!result.ok) {
				console.error("KeyboardLayout: " + result.err)
				return "err"
			}
			return result.value
		}

		export namespace State {
			export function Layout() {
				const [layout, setLayout] = createState("")
				void getLayout().then(setLayout)
				hypr.connect("keyboard-layout", () => void getLayout().then(setLayout))
				return <label label={layout} />
			}
		}
	}

	export function Button() {
		const handleScroll = (_: unknown, __: number, dy: number) => {
			const speaker = audio?.get_default_speaker()
			if (speaker) {
				const current = speaker.get_volume() ?? 0
				speaker.set_volume(Math.min(1, Math.max(0, current - dy * 0.025)))
			}
			return true
		}

		const handlePress = (self: Gtk.GestureClick) => {
			if (self.get_current_button() === BUTTON_MIDDLE) {
				const speaker = audio?.get_default_speaker()
				if (speaker) {
					speaker.set_mute(!speaker.get_mute())
				}
			}

			self.reset()
		}

		return (
			<PanelButton
				name="quicksettings"
				onClicked={() => toggleWindow("quicksettings")}
			>
				<Gtk.EventControllerScroll
					flags={SCROLL_VERTICAL}
					onScroll={handleScroll}
				/>
				<Gtk.GestureClick
					button={0}
					onPressed={handlePress}
				/>
				<box class="horizontal">
					<Keyboard.State.Layout />
					<Profiles.State.Power />
					<Profiles.State.Asus />
					<Audio.State.Speaker />
					<Audio.State.Microphone />
					<DND.State />
					<Network.State />
					<Bluetooth.State />
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		const players = createBinding(media, "players")

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
							self.paintable = textureFromFileSquareContain(env.paths.avatar, 64) as Gdk.Paintable
						})
					}}
					paintable={textureFromFileSquareContain(env.paths.avatar, 64) as Gdk.Paintable}
					widthRequest={64}
					heightRequest={64}
					halign={CENTER}
					valign={CENTER}
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

		const monitorHeights = app.get_monitors().map(m => m.get_geometry().height)
		const maxContentHeight = (monitorHeights.length ? Math.min(...monitorHeights) : 1080) - 96

		return (
			<PopupWindow
				name="quicksettings"
				exclusivity={EXCLUSIVE}
				application={app}
				layout={layout}
			>
				<Gtk.ScrolledWindow
					hscrollbarPolicy={Gtk.PolicyType.NEVER}
					vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
					propagateNaturalHeight
					propagateNaturalWidth
					maxContentHeight={maxContentHeight}
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
						<Row toggles={[DarkMode.Toggle, DND.Toggle]} />
						<Row toggles={[Profiles.Toggle, Mirror.Toggle]} menus={[Profiles.Selector, Mirror.Selector]} />
						<box
							class="media vertical"
							visible={players.as(list => list.length > 0)}
							orientation={VERTICAL}
						>
							<For each={players}>
								{(player: AstalMpris.Player) => <Audio.MediaPlayer player={player} />}
							</For>
						</box>
					</box>
				</Gtk.ScrolledWindow>
			</PopupWindow>
		)
	}
}
