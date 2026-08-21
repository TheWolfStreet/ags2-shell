// Shows network, audio, power, media, and display controls on each monitor.

import app from "ags/gtk4/app"
import { createBinding, createComputed, createState, For, onCleanup } from "ags"
import { monitorFile } from "ags/file"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import AstalMpris from "gi://AstalMpris"

import { Settings } from "widget/Settings"
import { PanelButton } from "widget/Bar/components/PanelButton"
import { createPopupPosition, PopupWindow } from "widget/shared/PopupWindow"
import { Network } from "./components/Network"
import { Audio } from "./components/Audio"
import { ToggleButton } from "./components/MenuControls"
import { Bluetooth } from "./components/Bluetooth"
import { DisplayMirroring } from "./components/DisplayMirroring"
import { MediaPlayer } from "./components/MediaPlayer"
import { PowerProfiles } from "./components/PowerProfiles"

import env from "$lib/env"
import icons, { getBrightnessIcon } from "$lib/icons"
import { attemptAsync } from "$lib/result"
import { textureFromFileSquareContain } from "$lib/textures"
import { brightness } from "$service/brightness"
import { audio, hyprland, media, notificationDaemon } from "$service/astal"

import options from "$shell/options"

export namespace QuickSettings {
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
				targetWindow="quicksettings"
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
					<KeyboardLayout />
					<PowerProfiles.State.Power />
					<PowerProfiles.State.Asus />
					<Audio.State.Speaker />
					<Audio.State.Microphone />
					<DoNotDisturbState />
					<Network.State />
					<Bluetooth.State />
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		Network.Wifi.Window()

		const players = createBinding(media, "players")
		const avatarSize = options.scale.as(scale => Math.round(56 * scale / 100))
		const popupWidth = createComputed(() => Math.round(quicksettings.width() * options.scale() / 100))

		function ToggleRow({ toggles, menus = [] }: { toggles: JSX.Element[], menus?: JSX.Element[] }) {
			return (
				<box orientation={VERTICAL}>
					<box class="row horizontal" homogeneous>
						{toggles}
					</box>
					{menus}
				</box>
			)
		}

		const Avatar = () => (
			<Gtk.Picture
				class="avatar"
				$={self => {
					const refresh = () => {
						self.paintable = textureFromFileSquareContain(env.paths.avatar, avatarSize.peek()) as Gdk.Paintable
					}
					const monitor = monitorFile(env.paths.avatar, refresh)
					const unsubscribe = avatarSize.subscribe(refresh)
					refresh()
					onCleanup(() => {
						monitor.cancel()
						unsubscribe()
					})
				}}
				widthRequest={avatarSize}
				heightRequest={avatarSize}
				halign={CENTER}
				valign={CENTER}
				contentFit={COVER}
				canShrink
			/>
		)

		const Header = () =>
			<box class="header horizontal">
				<Avatar />
				<box orientation={VERTICAL} valign={CENTER}>
					<box>
						<label class="username" label={env.username} />
					</box>
				</box>
				<box hexpand />
				<Settings.Button />
			</box >

		const monitorHeights = app.get_monitors().map(m => m.get_geometry().height)
		const monitorHeight = monitorHeights.length ? Math.min(...monitorHeights) : 1080
		const maxContentHeight = options.scale.as(scale => monitorHeight - Math.round(96 * scale / 100))

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
						css={popupWidth.as(width => `min-width: ${width}px;`)}
						orientation={VERTICAL}>
						<Header />
						<box class="sliders-box vertical" orientation={VERTICAL}>
							<ToggleRow
								toggles={[<Audio.Sliders.Volume />]}
								menus={[<Audio.SinkSelector />, <Audio.AppMixer />]}
							/>
							<Audio.Sliders.Microphone />
							<BrightnessSlider />
						</box>
						<ToggleRow
							toggles={[<Network.Wifi.Toggle />, <Bluetooth.Toggle />]}
							menus={[<Network.Wifi.Selector />, <Bluetooth.Selector />]}
						/>
						<ToggleRow toggles={[<DarkModeToggle />, <DoNotDisturbToggle />]} />
						<ToggleRow
							toggles={[<PowerProfiles.Toggle />, <DisplayMirroring.Toggle />]}
							menus={[<PowerProfiles.Selector />, <DisplayMirroring.Selector />]}
						/>
						<box
							class="media vertical"
							visible={players.as(list => list.length > 0)}
							orientation={VERTICAL}
						>
							<For each={players}>
								{(player: AstalMpris.Player) => <MediaPlayer player={player} />}
							</For>
						</box>
					</box>
				</Gtk.ScrolledWindow>
			</PopupWindow>
		)
	}
}

const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { VERTICAL: SCROLL_VERTICAL } = Gtk.EventControllerScrollFlags
const { COVER } = Gtk.ContentFit

const { EXCLUSIVE } = Astal.Exclusivity
const { BUTTON_MIDDLE } = Gdk

const { bar, quicksettings } = options
const { scheme } = options.theme

const layout = createPopupPosition(bar.position, quicksettings.position)

const LAYOUT_CODES: Record<string, string> = {
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
	"avatime": "avt", "cherokee": "chr", "crimean": "crh", "dhivehi": "dv",
}

async function queryKeyboardLayout(): Promise<string> {
	const result = await attemptAsync(async (): Promise<string> => {
		const output = (await execAsync("hyprctl devices -j")).trim()
		if (!output) return "err"

		const data = JSON.parse(output) as { keyboards?: Array<{ active_keymap?: string, main?: boolean }> }
		const keyboards = Array.isArray(data.keyboards) ? data.keyboards : []
		for (const keyboard of keyboards) {
			if (keyboard.main && typeof keyboard.active_keymap === "string" && keyboard.active_keymap.length > 0) {
				const keymap = keyboard.active_keymap.trim().split(/[\s(]/)[0].toLowerCase()
				return LAYOUT_CODES[keymap] || keymap
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

function KeyboardLayout() {
	const [layout, setLayout] = createState("")
	let active = true
	const update = () => void queryKeyboardLayout().then(value => {
		if (active) setLayout(value)
	})

	update()
	const connection = hyprland.connect("keyboard-layout", update)
	onCleanup(() => {
		active = false
		hyprland.disconnect(connection)
	})

	return <label label={layout} />
}

function BrightnessSlider() {
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
				<image iconName={display.as(value => getBrightnessIcon(value, "screen"))} useFallback />
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

function DarkModeToggle() {
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

const doNotDisturb = createBinding(notificationDaemon, "dontDisturb")

function DoNotDisturbToggle() {
	return (
		<ToggleButton
			iconName={doNotDisturb.as(v => v ? icons.notifications.silent : icons.notifications.noisy)}
			label={doNotDisturb.as(v => v ? "Silent" : "Normal")}
			toggle={() => notificationDaemon.set_dont_disturb(!notificationDaemon.get_dont_disturb())}
			connection={doNotDisturb}
		/>
	)
}

function DoNotDisturbState() {
	return (
		<image
			iconName={icons.notifications.silent}
			visible={doNotDisturb}
			useFallback
		/>
	)
}
