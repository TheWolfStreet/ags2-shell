import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
import { createState } from "ags"
import { Time, timeout } from "ags/time"

import giCairo from "cairo"

import PopupWindow from "widget/shared/PopupWindow"

import { audio, brightness } from "$lib/services"

import options from "options"

export default function OSD() {
	const [reveal, set_reveal] = createState(false)
	const [icon, set_icon] = createState("")
	const [value, set_value] = createState(0)
	const [mute, set_mute] = createState(false)

	let currentTime: Time | undefined = undefined

	function show(v: number, i: string, m: boolean) {
		set_value(v)
		set_icon(i)
		set_mute(m)
		set_reveal(true)

		if (currentTime) {
			currentTime.cancel()
		}

		currentTime = timeout(options.notifications.dismiss.get() / 3, () => {
			set_reveal(false)
		})
	}

	const spkr = audio.get_default_speaker()
	const mic = audio.get_default_microphone()

	// TODO: yeah, i know.
	// for some reason it fires events on app run
	//
	timeout(500, () => {
		brightness.connect("notify::display", () =>
			show(brightness.display, brightness.iconName, false)
		)
		brightness.connect("notify::kbd", () =>
			show(brightness.kbd, brightness.kbdIcon, false)
		)
		spkr.connect("notify::volume", () =>
			show(spkr.get_volume(), spkr.get_volume_icon(), spkr.get_mute())
		)
		spkr.connect("notify::mute", () =>
			show(spkr.get_volume(), spkr.get_volume_icon(), spkr.get_mute())
		)
		mic.connect("notify::volume", () =>
			show(mic.get_volume(), mic.get_volume_icon(), mic.get_mute())
		)
		mic.connect("notify::mute", () =>
			show(mic.get_volume(), mic.get_volume_icon(), mic.get_mute())
		)
	})

	const { VERTICAL } = Gtk.Orientation
	const { OVERLAY } = Astal.Layer
	const { EXCLUSIVE } = Astal.Exclusivity
	const { NONE } = Astal.Keymode
	return (
		<PopupWindow
			name="osd"
			visible={reveal}
			keymode={NONE}
			application={app}
			layer={OVERLAY}
			exclusivity={EXCLUSIVE}
			layout="bottom-center"
			handleClosing={false}
			onNotifyVisible={(w) => {
				w.get_surface()?.set_input_region(new giCairo.Region)
			}}
			$={w => {
				w.get_surface()?.set_input_region(new giCairo.Region)
			}}
		>
			<Gtk.AspectFrame obeyChild={false} ratio={1}>
				<box class="padding">
					<box class="content" orientation={VERTICAL}>
						<image iconName={icon} useFallback pixelSize={64} />
						<Gtk.ProgressBar class={mute.as(v => v ? "muted" : "")} fraction={value} />
					</box>
				</box>
			</Gtk.AspectFrame>
		</PopupWindow >
	)
}
