import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import { createState } from "ags"
import { timeout } from "ags/time"

import PopupWindow from "widget/shared/PopupWindow"

import { audio, brightness } from "$lib/services"

import options from "options"

export default function OSD() {
	const [reveal, set_reveal] = createState(false)
	const [icon, set_icon] = createState("")
	const [value, set_value] = createState(0)

	let count = 0

	function show(v: number, i: string) {
		set_reveal(true)
		set_value(v)
		set_icon(i)
		count++
		timeout(options.notifications.dismiss.get() / 3, () => {
			count--
			if (count === 0) set_reveal(false)
		})
	}

	const spkr = audio.get_default_speaker()
	const mic = audio.get_default_microphone()

	// TODO: yeah, i know
	// for some reason they fire events on app run
	timeout(500, () => {
		brightness.connect("notify::display", () =>
			show(brightness.display, brightness.iconName)
		)
		brightness.connect("notify::kbd", () =>
			show(brightness.kbd, brightness.kbdIcon)
		)
		spkr.connect("notify::volume", () =>
			show(spkr.volume, spkr.volumeIcon)
		)
		spkr.connect("notify::mute", () =>
			show(spkr.volume, spkr.volumeIcon)
		)
		mic.connect("notify::volume", () =>
			show(mic.volume, mic.volumeIcon)
		)
		mic.connect("notify::mute", () =>
			show(mic.volume, mic.volumeIcon)
		)
	})

	const { VERTICAL } = Gtk.Orientation

	return (
		<PopupWindow
			name="osd"
			application={app}
			visible={reveal}
			layout="bottom-center"
		>
			<Gtk.AspectFrame obeyChild={false} ratio={1}>
				<box orientation={VERTICAL}>
					<image iconName={icon} useFallback pixelSize={64} />
					<Gtk.ProgressBar fraction={value} />
				</box>
			</Gtk.AspectFrame>
		</PopupWindow>
	)
}
