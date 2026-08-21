// Shows a brief volume or brightness indicator on the active monitor.

import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
import { Timer, timeout } from "ags/time"
import { createState, onCleanup } from "ags"

import AstalWp from "gi://AstalWp"

import { PopupWindow, Position } from "widget/shared/PopupWindow"

import { brightness } from "$service/brightness"
import { getBrightnessIcon } from "$lib/icons"
import { ignoreInput } from "$lib/windowing"
import options, { Opt } from "$shell/options"

const audio = AstalWp.get_default()

export namespace OSD {
	export function Window() {
		if (window) return window
		const disconnectListeners = connectListeners()
		onCleanup(() => {
			hideTimer?.cancel()
			hideTimer = undefined
			disconnectListeners()
			window = null
		})
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
					<box class="state-display" orientation={VERTICAL} hexpand vexpand>
						<image
							iconName={content.as((value) => value.icon)}
							pixelSize={options.scale.as((scale) =>
								Math.round((64 * scale) / 100),
							)}
							useFallback
							vexpand
							hexpand
						/>
						<Gtk.ProgressBar
							class={content.as((value) =>
								value.muted ? "percentage muted" : "percentage",
							)}
							fraction={content.as((value) => value.value)}
							hexpand
						/>
					</box>
				</Gtk.AspectFrame>
			</PopupWindow>
		) as Gtk.Window
		return window
	}

	type Content = {
		icon: string
		value: number
		muted: boolean
	}

	const [reveal, setReveal] = createState(false)
	const [content, setContent] = createState<Content>({
		icon: "",
		value: 0,
		muted: false,
	})

	let hideTimer: Timer | undefined
	let window: Gtk.Window | null = null

	function show(value: number, icon: string, muted: boolean) {
		setContent({ value, icon, muted })
		setReveal(true)

		hideTimer?.cancel()
		hideTimer = timeout(options.osd.dismiss.peek(), () => {
			setReveal(false)
		})
	}

	function connectListeners() {
		type AudioEndpoint = ReturnType<typeof audio.get_default_speaker>

		const watchEndpoint = (
			getEndpoint: () => AudioEndpoint,
			defaultChangedSignal: string,
		) => {
			let endpoint: AudioEndpoint | null = null
			let endpointHandlers: number[] = []

			const disconnectEndpoint = () => {
				if (endpoint) {
					for (const handler of endpointHandlers) endpoint.disconnect(handler)
				}
				endpoint = null
				endpointHandlers = []
			}

			const reconnectEndpoint = () => {
				disconnectEndpoint()
				endpoint = getEndpoint()
				if (!endpoint) return

				const showEndpoint = () => {
					if (endpoint)
						show(
							endpoint.get_volume(),
							endpoint.get_volume_icon(),
							endpoint.get_mute(),
						)
				}
				endpointHandlers = [
					endpoint.connect("notify::volume", showEndpoint),
					endpoint.connect("notify::mute", showEndpoint),
				]
			}

			reconnectEndpoint()
			const defaultHandler = audio.connect(
				defaultChangedSignal,
				reconnectEndpoint,
			)

			return () => {
				audio.disconnect(defaultHandler)
				disconnectEndpoint()
			}
		}

		const disconnectSpeaker = watchEndpoint(
			() => audio.get_default_speaker(),
			"notify::default-speaker",
		)
		const disconnectMicrophone = watchEndpoint(
			() => audio.get_default_microphone(),
			"notify::default-microphone",
		)
		const displayHandler = brightness.connect("notify::display", () => {
			if (!brightness.initialized) return
			show(
				brightness.display,
				getBrightnessIcon(brightness.display, "screen"),
				false,
			)
		})
		const keyboardHandler = brightness.connect("notify::kbd", () => {
			if (!brightness.initialized) return
			show(brightness.kbd, getBrightnessIcon(brightness.kbd, "keyboard"), false)
		})

		return () => {
			disconnectSpeaker()
			disconnectMicrophone()
			brightness.disconnect(displayHandler)
			brightness.disconnect(keyboardHandler)
		}
	}

	const { VERTICAL } = Gtk.Orientation
	const { OVERLAY } = Astal.Layer
	const { IGNORE } = Astal.Exclusivity
	const { NONE } = Astal.Keymode
}
