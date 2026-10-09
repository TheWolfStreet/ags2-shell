import app from "$lib/app"
import { Astal, Gtk } from "ags/gtk4"
import { type Timer, timeout } from "$lib/time"
import { createState, onCleanup } from "ags"

import AstalWp from "gi://AstalWp"

import { PopupWindow, Position } from "widget/shared/PopupWindow"

import { brightness } from "$service/brightness"
import { get_brightness_icon } from "$lib/icons"
import { ignore_input } from "$lib/windowing"
import options, { Opt } from "$shell/options"

const audio = AstalWp.get_default()

export namespace OSD {
	export function Window() {
		if (window) return window
		const disconnect_listeners = connect_listeners()
		onCleanup(() => {
			hide_timer?.cancel()
			hide_timer = undefined
			disconnect_listeners()
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
				onNotifyVisible={ignore_input}
				$={ignore_input}
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
							fraction={content.as((value) =>
								Number.isFinite(value.value)
									? Math.max(0, Math.min(1, value.value))
									: 0,
							)}
							hexpand
						/>
					</box>
				</Gtk.AspectFrame>
			</PopupWindow>
		) as Gtk.Window
		return window
	}

	type osd_content = {
		icon: string
		value: number
		muted: boolean
	}

	const [reveal, set_reveal] = createState(false)
	const [content, set_content] = createState<osd_content>({
		icon: "",
		value: 0,
		muted: false,
	})

	let hide_timer: Timer | undefined
	let window: Gtk.Window | null = null

	function show(value: number, icon: string, muted: boolean) {
		set_content({ value, icon, muted })
		set_reveal(true)

		hide_timer?.cancel()
		hide_timer = timeout(options.osd.dismiss.peek(), () => {
			set_reveal(false)
		})
	}

	function connect_listeners() {
		type audio_endpoint = ReturnType<typeof audio.get_default_speaker>

		const watch_endpoint = (
			get_endpoint: () => audio_endpoint,
			default_changed_signal: string,
		) => {
			let endpoint: audio_endpoint | null = null
			let endpoint_handlers: number[] = []

			const disconnect_endpoint = () => {
				if (endpoint) {
					for (const handler of endpoint_handlers) endpoint.disconnect(handler)
				}
				endpoint = null
				endpoint_handlers = []
			}

			const reconnect_endpoint = () => {
				disconnect_endpoint()
				endpoint = get_endpoint()
				if (!endpoint) return

				const show_endpoint = () => {
					if (endpoint)
						show(
							endpoint.get_volume(),
							endpoint.get_volume_icon(),
							endpoint.get_mute(),
						)
				}
				endpoint_handlers = [
					endpoint.connect("notify::volume", show_endpoint),
					endpoint.connect("notify::mute", show_endpoint),
				]
			}

			reconnect_endpoint()
			const default_handler = audio.connect(
				default_changed_signal,
				reconnect_endpoint,
			)

			return () => {
				audio.disconnect(default_handler)
				disconnect_endpoint()
			}
		}

		const disconnect_speaker = watch_endpoint(
			() => audio.get_default_speaker(),
			"notify::default-speaker",
		)
		const disconnect_microphone = watch_endpoint(
			() => audio.get_default_microphone(),
			"notify::default-microphone",
		)
		const display_handler = brightness.connect("notify::display", () => {
			if (!brightness.initialized) return
			show(
				brightness.display,
				get_brightness_icon(brightness.display, "screen"),
				false,
			)
		})
		const keyboard_handler = brightness.connect("notify::kbd", () => {
			if (!brightness.initialized) return
			show(
				brightness.kbd,
				get_brightness_icon(brightness.kbd, "keyboard"),
				false,
			)
		})

		return () => {
			disconnect_speaker()
			disconnect_microphone()
			brightness.disconnect(display_handler)
			brightness.disconnect(keyboard_handler)
		}
	}

	const { VERTICAL } = Gtk.Orientation
	const { OVERLAY } = Astal.Layer
	const { IGNORE } = Astal.Exclusivity
	const { NONE } = Astal.Keymode
}
