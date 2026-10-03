import app from "$lib/app"
import { createBinding, createComputed, createState, For, onCleanup } from "ags"
import { monitorFile } from "ags/file"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import AstalMpris from "gi://AstalMpris"
import AstalWp from "gi://AstalWp"

import { Settings } from "widget/Settings"
import { PanelButton } from "widget/Bar/components/PanelButton"
import { create_popup_position, PopupWindow } from "widget/shared/PopupWindow"
import { Network } from "./components/Network"
import { Audio } from "./components/Audio"
import { ToggleButton } from "./components/MenuControls"
import { Bluetooth } from "./components/Bluetooth"
import { DisplayMirroring } from "./components/DisplayMirroring"
import { MediaPlayer } from "./components/MediaPlayer"
import { PowerProfiles } from "./components/PowerProfiles"

import env from "$lib/env"
import icons, { get_brightness_icon } from "$lib/icons"
import { attempt, attempt_async, err, log_error, ok, type Result } from "$lib/result"
import { texture_from_file_square_contain } from "$lib/textures"
import { hyprland } from "$lib/hyprland"
import { notification_daemon } from "$lib/notifications"
import { brightness } from "$service/brightness"

import options, { ui_scale } from "$shell/options"

const audio = AstalWp.get_default()
const media = AstalMpris.get_default()

export namespace QuickSettings {
	export function Button() {
		const handle_scroll = (controller: unknown, dx: number, dy: number) => {
			const speaker = audio?.get_default_speaker()
			if (speaker) {
				const current = speaker.get_volume() ?? 0
				speaker.set_volume(Math.min(1, Math.max(0, current - dy * 0.025)))
			}
			return true
		}

		const handle_press = (self: Gtk.GestureClick) => {
			if (self.get_current_button() === BUTTON_MIDDLE) {
				const speaker = audio?.get_default_speaker()
				if (speaker) {
					speaker.set_mute(!speaker.get_mute())
				}
			}

			self.reset()
		}

		return (
			<PanelButton targetWindow="quicksettings">
				<Gtk.EventControllerScroll
					flags={SCROLL_VERTICAL}
					onScroll={handle_scroll}
				/>
				<Gtk.GestureClick button={0} onPressed={handle_press} />
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
		const avatar_size = options.scale.as(() => Math.round(56 * ui_scale()))
		const popup_width = createComputed(() =>
			Math.round(quicksettings.width() * ui_scale()),
		)

		function ToggleRow({
			toggles,
			menus = [],
		}: {
			toggles: JSX.Element[]
			menus?: JSX.Element[]
		}) {
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
				$={(self) => {
					const refresh = () => {
						self.paintable = texture_from_file_square_contain(
							env.paths.avatar,
							avatar_size.peek(),
						) as Gdk.Paintable
					}
					const monitored = attempt(() => monitorFile(env.paths.avatar, refresh))
					if (!monitored.ok) console.error("quicksettings.avatar: Failed to watch avatar", monitored.err)
					const unsubscribe = avatar_size.subscribe(refresh)
					refresh()
					onCleanup(() => {
						if (monitored.ok) monitored.value.cancel()
						unsubscribe()
					})
				}}
				widthRequest={avatar_size}
				heightRequest={avatar_size}
				halign={CENTER}
				valign={CENTER}
				contentFit={COVER}
				canShrink
			/>
		)

		const Header = () => (
			<box class="header horizontal">
				<Avatar />
				<box orientation={VERTICAL} valign={CENTER}>
					<box>
						<label class="username" label={env.username} />
					</box>
				</box>
				<box hexpand />
				<Settings.Button />
			</box>
		)

		const [monitors, set_monitors] = createState(app.get_monitors())
		let geometry_handlers: Array<[Gdk.Monitor, number]> = []
		const refresh_monitors = () => {
			for (const [monitor, handler] of geometry_handlers) monitor.disconnect(handler)
			const current = app.get_monitors()
			geometry_handlers = current.map((monitor) => [monitor, monitor.connect("notify::geometry", () => set_monitors([...current]))])
			set_monitors(current)
		}
		const monitors_handler = app.connect("notify::monitors", refresh_monitors)
		refresh_monitors()
		onCleanup(() => {
			app.disconnect(monitors_handler)
			for (const [monitor, handler] of geometry_handlers) monitor.disconnect(handler)
		})
		const max_content_height = createComputed(() => {
			const heights = monitors().map((monitor) => monitor.get_geometry().height)
			const minimum = heights.length ? Math.min(...heights) : 1080
			return Math.max(200, minimum - Math.round(96 * ui_scale()))
		})

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
					maxContentHeight={max_content_height}
				>
					<box
						class="quicksettings vertical"
						css={popup_width.as((width) => `min-width: ${width}px;`)}
						orientation={VERTICAL}
					>
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
							menus={[
								<PowerProfiles.Selector />,
								<DisplayMirroring.Selector />,
							]}
						/>
						<box
							class="media vertical"
							visible={players.as((list) => list.length > 0)}
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

const layout = create_popup_position(bar.position, quicksettings.position)

const layout_codes: Record<string, string> = {
	english: "en",
	russian: "ru",
	hebrew: "he",
	arabic: "ar",
	chinese: "zh",
	japanese: "ja",
	korean: "ko",
	french: "fr",
	german: "de",
	spanish: "es",
	italian: "it",
	portuguese: "pt",
	dutch: "nl",
	polish: "pl",
	turkish: "tr",
	greek: "el",
	ukrainian: "uk",
	czech: "cs",
	slovak: "sk",
	hungarian: "hu",
	romanian: "ro",
	bulgarian: "bg",
	croatian: "hr",
	serbian: "sr",
	slovene: "sl",
	latvian: "lv",
	lithuanian: "lt",
	estonian: "et",
	finnish: "fi",
	swedish: "sv",
	norwegian: "no",
	danish: "da",
	icelandic: "is",
	thai: "th",
	vietnamese: "vi",
	hindi: "hi",
	bengali: "bn",
	tamil: "ta",
	telugu: "te",
	urdu: "ur",
	persian: "fa",
	farsi: "fa",
	malayalam: "ml",
	malagasy: "mg",
	malay: "ms",
	swahili: "sw",
	yoruba: "yo",
	zulu: "zu",
	amharic: "am",
	mongolian: "mn",
	khmer: "km",
	lao: "lo",
	burmese: "my",
	welsh: "cy",
	irish: "ga",
	basque: "eu",
	catalan: "ca",
	galician: "gl",
	albanian: "sq",
	macedonian: "mk",
	bosnian: "bs",
	montenegrin: "cnr",
	belarusian: "be",
	azerbaijani: "az",
	georgian: "ka",
	armenian: "hy",
	kazakh: "kk",
	kyrgyz: "ky",
	uzbek: "uz",
	tajik: "tg",
	turkmen: "tk",
	pashto: "ps",
	dari: "prs",
	kurdish: "ku",
	afrikaans: "af",
	akan: "ak",
	bambara: "bm",
	berber: "ber",
	chuvash: "cv",
	esperanto: "eo",
	ewe: "ee",
	faroese: "fo",
	filipino: "fil",
	friulian: "fur",
	fulah: "ff",
	gagauz: "gag",
	igbo: "ig",
	ido: "io",
	indonesian: "id",
	inuktitut: "iu",
	javanese: "jv",
	kannada: "kn",
	kanuri: "kr",
	kashmiri: "ks",
	kikuyu: "ki",
	kinyarwanda: "rw",
	komi: "kv",
	maltese: "mt",
	maori: "mi",
	marathi: "mr",
	northern: "se",
	yakut: "sah",
	abkhazian: "ab",
	asturian: "ast",
	avatime: "avt",
	cherokee: "chr",
	crimean: "crh",
	dhivehi: "dv",
}

function layout_code(keymap: string): string {
	const name = keymap.trim().split(/[\s(]/)[0].toLowerCase()
	return layout_codes[name] || name || "unk"
}

async function query_keyboard_layout(): Promise<Result<string>> {
	const result = await attempt_async(async () => {
		const output = await execAsync(["hyprctl", "devices", "-j"])
		return JSON.parse(output) as {
			keyboards?: Array<{ active_keymap?: string; main?: boolean }>
		}
	})
	if (!result.ok) return result

	const keyboards = Array.isArray(result.value?.keyboards) ? result.value.keyboards : []
	for (const keyboard of keyboards) {
		if (!keyboard?.main) continue
		if (typeof keyboard.active_keymap !== "string") return err("Main keyboard has no active keymap")
		const keymap = keyboard.active_keymap.trim().toLowerCase()
		if (!keymap || keymap === "error" || keymap === "none") return err(`Invalid main keyboard layout: ${keymap}`)
		return ok(layout_code(keymap))
	}
	return err("No main keyboard layout")
}

function KeyboardLayout() {
	if (++keyboard_users === 1) {
		refresh_keyboard_layout()
		keyboard_handler = hyprland.connect("keyboard-layout", refresh_keyboard_layout)
	}
	onCleanup(() => {
		if (--keyboard_users === 0) {
			keyboard_revision++
			hyprland.disconnect(keyboard_handler)
		}
	})
	return <label label={keyboard_layout} />
}

const [keyboard_layout, set_keyboard_layout] = createState("")
let keyboard_users = 0
let keyboard_handler = 0
let keyboard_revision = 0
function refresh_keyboard_layout() {
	const revision = ++keyboard_revision
	void query_keyboard_layout().then((result) => {
		if (!keyboard_users || revision !== keyboard_revision) return
		if (log_error(result, "KeyboardLayout: failed to read layout")) set_keyboard_layout(result.value)
	})
}

function BrightnessSlider() {
	let prev_brightness = 1

	const toggle_brightness_mute = () => {
		if (brightness.display > 0) {
			prev_brightness = brightness.display
			void brightness.set_display(0).then((result) => {
				if (!result.ok) console.error("brightness.toggle:", result.err)
			})
		} else {
			void brightness.set_display(prev_brightness).then((result) => {
				if (!result.ok) console.error("brightness.toggle:", result.err)
			})
		}
	}

	const display = createBinding(brightness, "display")

	return (
		<box
			class="control-unit"
			visible={createBinding(brightness, "displayAvailable")}
		>
			<button
				valign={CENTER}
				onClicked={toggle_brightness_mute}
				tooltipText={display.as(
					(v) => `Screen Brightness: ${Math.floor(v * 100)}% `,
				)}
			>
				<image
					iconName={display.as((value) => get_brightness_icon(value, "screen"))}
					useFallback
				/>
			</button>
			<slider
				drawValue={false}
				hexpand
				value={display}
				onChangeValue={({ value }) => {
					void brightness.set_display(value).then((result) => {
						if (!result.ok) console.error("brightness.slider:", result.err)
					})
				}}
			/>
		</box>
	)
}

function DarkModeToggle() {
	const is_dark = scheme.as((s) => s === "dark")

	const toggle_theme_scheme = () => {
		scheme.set(is_dark.peek() ? "light" : "dark")
	}

	return (
		<ToggleButton
			iconName={is_dark.as((dark) => icons.color[dark ? "dark" : "light"])}
			label={is_dark.as((dark) => (dark ? "Dark" : "Light"))}
			onToggle={toggle_theme_scheme}
			connection={is_dark}
		/>
	)
}

const do_not_disturb = createBinding(notification_daemon, "dontDisturb")

function DoNotDisturbToggle() {
	return (
		<ToggleButton
			iconName={do_not_disturb.as((v) =>
				v ? icons.notifications.silent : icons.notifications.noisy,
			)}
			label={do_not_disturb.as((v) => (v ? "Silent" : "Normal"))}
			onToggle={() =>
				notification_daemon.set_dont_disturb(
					!notification_daemon.get_dont_disturb(),
				)
			}
			connection={do_not_disturb}
		/>
	)
}

function DoNotDisturbState() {
	return (
		<image
			iconName={icons.notifications.silent}
			visible={do_not_disturb}
			useFallback
		/>
	)
}
