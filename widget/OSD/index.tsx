// Shows a brief volume or brightness indicator on the active monitor.

import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
import { Timer, timeout } from "ags/time"
import { createState } from "ags"

import { PopupWindow, Position } from "widget/Windowing/PopupWindow"

import { brightness } from "$service/brightness"
import { audio } from "$service/astal"
import { ignoreInput } from "widget/Windowing/WindowControl"
import { Opt } from "$lib/option"

import options from "options"

const { VERTICAL } = Gtk.Orientation
const { OVERLAY } = Astal.Layer
const { IGNORE } = Astal.Exclusivity
const { NONE } = Astal.Keymode

export namespace OSD {
	const [reveal, setReveal] = createState(false)
	const [icon, setIcon] = createState("")
	const [value, setValue] = createState(0)
	const [muted, setMuted] = createState(false)

	let hideTimer: Timer | undefined
	let window: Gtk.Window | null = null

	function show(level: number, iconName: string, isMuted: boolean) {
		setValue(level)
		setIcon(iconName)
		setMuted(isMuted)
		setReveal(true)

		hideTimer?.cancel()
		hideTimer = timeout(options.notifications.dismiss.peek() / 3, () => {
			setReveal(false)
		})
	}

	function connectListeners() {
		const speaker = audio.get_default_speaker()
		const microphone = audio.get_default_microphone()

		brightness.connect("notify::display", () => {
			show(brightness.display, brightness.iconName, false)
		})
		brightness.connect("notify::kbd", () => {
			show(brightness.kbd, brightness.kbdIcon, false)
		})
		speaker.connect("notify::volume", () => {
			show(speaker.get_volume(), speaker.get_volume_icon(), speaker.get_mute())
		})
		speaker.connect("notify::mute", () => {
			show(speaker.get_volume(), speaker.get_volume_icon(), speaker.get_mute())
		})
		microphone.connect("notify::volume", () => {
			show(microphone.get_volume(), microphone.get_volume_icon(), microphone.get_mute())
		})
		microphone.connect("notify::mute", () => {
			show(microphone.get_volume(), microphone.get_volume_icon(), microphone.get_mute())
		})
	}

	export function Window() {
		if (window) return window
		connectListeners()
		window = (
			<PopupWindow
				name="state-display"
				visible={reveal}
				keymode={NONE}
				exclusivity={IGNORE}
				anchor={undefined}
				layer={OVERLAY}
				application={app}
				layout={options.osd.position as Opt<Position>}
				handleClosing={false}
				onNotifyVisible={ignoreInput}
				$={ignoreInput}
			>
				<Gtk.AspectFrame obeyChild={false} ratio={1}>
					<box
						class="state-display" orientation={VERTICAL} hexpand vexpand>
						<image iconName={icon} pixelSize={options.scale.as(scale => Math.round(64 * scale / 100))} useFallback vexpand hexpand />
						<Gtk.ProgressBar class={muted.as(v => v ? "percentage muted" : "percentage")} fraction={value} hexpand />
					</box>
				</Gtk.AspectFrame>
			</PopupWindow >
		) as Gtk.Window
		return window
	}
}
