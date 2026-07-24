// Shows a brief volume or brightness indicator on the active monitor.

import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
import { Timer, timeout } from "ags/time"
import { createState } from "ags"

import { PopupWindow, Position } from "widget/shared/PopupWindow"

import { brightness } from "$service/brightness"
import { audio } from "$service/system"
import { ignoreInput } from "$lib/windows"
import { Opt } from "$lib/option"

import options from "options"

const { VERTICAL } = Gtk.Orientation
const { OVERLAY } = Astal.Layer
const { IGNORE } = Astal.Exclusivity
const { NONE } = Astal.Keymode

export namespace OSD {
	// The OSD owns one window and one shutdown-scoped set of service listeners.
	const [reveal, setReveal] = createState(false)
	const [icon, setIcon] = createState("")
	const [value, setValue] = createState(0)
	const [muted, setMuted] = createState(false)

	let current: Timer | undefined
	let setupTimer: Timer | null = null
	let shutdownSignalId = 0
	let window: Gtk.Window | null = null
	let connected = false
	const signalIds: Array<{ source: { disconnect(id: number): void }, id: number }> = []

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
		if (connected || setupTimer) return
		setupTimer = timeout(1000, () => {
			setupTimer = null
			if (connected) return
			connected = true
			const spkr = audio.get_default_speaker()
			const mic = audio.get_default_microphone()

			signalIds.push(
				{ source: brightness, id: brightness.connect("notify::display", () =>
					show(brightness.display, brightness.iconName, false)
				) },
				{ source: brightness, id: brightness.connect("notify::kbd", () =>
					show(brightness.kbd, brightness.kbdIcon, false)
				) },

				{ source: spkr, id: spkr.connect("notify::volume", () =>
					show(spkr.get_volume(), spkr.get_volume_icon(), spkr.get_mute())
				) },

				{ source: spkr, id: spkr.connect("notify::mute", () =>
					show(spkr.get_volume(), spkr.get_volume_icon(), spkr.get_mute())
				) },

				{ source: mic, id: mic.connect("notify::volume", () =>
					show(mic.get_volume(), mic.get_volume_icon(), mic.get_mute())
				) },

				{ source: mic, id: mic.connect("notify::mute", () =>
					show(mic.get_volume(), mic.get_volume_icon(), mic.get_mute())
				) },
			)
		})

		if (!shutdownSignalId) shutdownSignalId = app.connect("shutdown", cleanup)
	}

	function cleanup() {
		setupTimer?.cancel()
		setupTimer = null
		current?.cancel()
		current = undefined
		for (const { source, id } of signalIds) source.disconnect(id)
		signalIds.length = 0
		connected = false
		if (shutdownSignalId) {
			app.disconnect(shutdownSignalId)
			shutdownSignalId = 0
		}
	}

	export function Window() {
		if (window) return window
		connectState()
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
						<image iconName={icon} pixelSize={64} useFallback vexpand hexpand />
						<Gtk.ProgressBar class={muted.as(v => v ? "percentage muted" : "percentage")} fraction={value} hexpand />
					</box>
				</Gtk.AspectFrame>
			</PopupWindow >
		) as Gtk.Window
		return window
	}
}
