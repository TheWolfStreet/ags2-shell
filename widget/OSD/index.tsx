import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
import { Timer, timeout } from "ags/time"
import { createState } from "ags"

import { PopupWindow, Position } from "widget/shared/PopupWindow"

import { audio, brightness } from "$lib/services"
import { ignoreInput } from "$lib/utils"
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

	let current: Timer | undefined

	function show(value: number, icon: string, muted: boolean) {
		setValue(value)
		setIcon(icon)
		setMuted(muted)

		if (!app.get_window("state-display")?.get_visible()) {
			setReveal(true)
		}

		if (current) {
			current.cancel()
		}

		current = timeout(options.notifications.dismiss.peek() / 3, () => {
			setReveal(false)
		})
	}

	function connectState() {
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
	}

	export function Window() {
		connectState()
		return (
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
						<image iconName={icon} pixelSize={64} useFallback vexpand hexpand />
						<Gtk.ProgressBar class={muted.as(v => v ? "percentage muted" : "percentage")} fraction={value} hexpand />
					</box>
				</Gtk.AspectFrame>
			</PopupWindow >
		)
	}
}
