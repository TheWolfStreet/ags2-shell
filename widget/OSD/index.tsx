import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
import { Timer, timeout } from "ags/time"
import { createState } from "ags"

import { PopupWindow } from "widget/shared/PopupWindow"

import { audio, brightness } from "$lib/services"
import { ignoreInput } from "$lib/utils"

import options from "options"

const { VERTICAL } = Gtk.Orientation
const { OVERLAY } = Astal.Layer
const { EXCLUSIVE } = Astal.Exclusivity
const { NONE } = Astal.Keymode

const [reveal, set_reveal] = createState(false)
const [icon, set_icon] = createState("")
const [value, set_value] = createState(0)
const [mute, set_mute] = createState(false)

let current: Timer | undefined = undefined

function show(v: number, i: string, m: boolean) {
	set_value(v)
	set_icon(i)
	set_mute(m)

	// FIXME: Not really a solution. This is an underlying problem within the PopupWindow
	if (!app.get_window("state-display")?.get_visible()) {
		set_reveal(true)
	}

	if (current) {
		current.cancel()
	}

	current = timeout(options.notifications.dismiss.peek() / 3, () => {
		set_reveal(false)
	})
}

export function OSD() {
	const spkr = audio.get_default_speaker()
	const mic = audio.get_default_microphone()
	timeout(1000, () => {
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
	return (
		<PopupWindow
			name="state-display"
			visible={reveal}
			keymode={NONE}
			exclusivity={EXCLUSIVE}
			layer={OVERLAY}
			application={app}
			layout="bottom-center"
			handleClosing={false}
			onNotifyVisible={ignoreInput}
			$={ignoreInput}
		>
			<Gtk.AspectFrame obeyChild={false} ratio={1}>
				<box
					class="state-display" orientation={VERTICAL} hexpand vexpand>
					<image iconName={icon} pixelSize={64} useFallback vexpand hexpand />
					<Gtk.ProgressBar class={mute.as(v => v ? "percentage muted" : "percentage")} fraction={value} hexpand />
				</box>
			</Gtk.AspectFrame>
		</PopupWindow >
	)
}
