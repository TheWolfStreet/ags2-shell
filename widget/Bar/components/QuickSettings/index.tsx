// Shows network, audio, power, media, and display controls on each monitor.

import app from "ags/gtk4/app"
import { createBinding, createState, For, onCleanup } from "ags"
import { monitorFile } from "ags/file"
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
import { KeyboardLayout } from "./KeyboardLayout"

import env from "$lib/env"
import icons from "$lib/icons"
import { popupLayout } from "$lib/popup"
import { toggleWindow } from "$lib/windows"
import { textureFromFileSquareContain } from "$lib/textures"
import { brightness } from "$service/brightness"
import { audio, media } from "$service/system"

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
					<KeyboardLayout />
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

		// Each toggle row is followed by the collapsible menus controlled by those toggles.
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
					const monitor = monitorFile(env.paths.avatar, () => {
						self.paintable = textureFromFileSquareContain(env.paths.avatar, 64) as Gdk.Paintable
					})
					onCleanup(() => monitor.cancel())
				}}
				paintable={textureFromFileSquareContain(env.paths.avatar, 64) as Gdk.Paintable}
				widthRequest={64}
				heightRequest={64}
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
						css={quicksettings.width.as((width: number) => `min-width: ${width}px;`)}
						orientation={VERTICAL}>
						<Header />
						<box class="sliders-box vertical" orientation={VERTICAL}>
							<ToggleRow
								toggles={[<Audio.Sliders.Volume />]}
								menus={[<Audio.SinkSelector />, <Audio.AppMixer />]}
							/>
							<Audio.Sliders.Microphone />
							<Sliders.Brightness />
						</box>
						<ToggleRow
							toggles={[<Network.Wifi.Toggle />, <Bluetooth.Toggle />]}
							menus={[<Network.Wifi.Selector />, <Bluetooth.Selector />]}
						/>
						<ToggleRow toggles={[<DarkMode.Toggle />, <DND.Toggle />]} />
						<ToggleRow
							toggles={[<Profiles.Toggle />, <Mirror.Toggle />]}
							menus={[<Profiles.Selector />, <Mirror.Selector />]}
						/>
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
