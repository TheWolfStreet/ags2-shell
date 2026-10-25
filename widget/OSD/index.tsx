import app from "$lib/app"
import { Astal, Gtk } from "ags/gtk4"
import { type timer, timeout } from "$lib/time"
import { createState, onCleanup } from "ags"

import AstalWp from "gi://AstalWp"

import { PopupWindow } from "widget/shared/PopupWindow"

import { brightness } from "$service/brightness"
import { get_brightness_icon } from "$lib/icons"
import { ignore_input } from "$lib/windowing"
import options, { scaled } from "$shell/options"

const audio = AstalWp.get_default()

export namespace OSD {
	const { VERTICAL } = Gtk.Orientation
	const { OVERLAY } = Astal.Layer
	const { IGNORE } = Astal.Exclusivity
	const { NONE } = Astal.Keymode

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
				layer={OVERLAY}
				application={app}
				layout={options.osd.position}
				handle_closing={false}
				onNotifyVisible={ignore_input}
				$={ignore_input}
			>
				<Gtk.AspectFrame obeyChild={false} ratio={1}>
					<box class="state-display" orientation={VERTICAL} hexpand vexpand>
						<image
							iconName={content.as((value) => value.icon)}
							pixelSize={scaled(64)}
							useFallback
							vexpand
							hexpand
						/>
						<Gtk.ProgressBar
							class={content.as((value) =>
								value.muted ? "percentage muted" : "percentage",
							)}
							fraction={content.as((value) => fraction(value.value))}
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

	let hide_timer: timer | undefined
	let window: Gtk.Window | null = null

	function fraction(value: number) {
		if (!Number.isFinite(value)) return 0
		return Math.max(0, Math.min(1, value))
	}

	function show(value: number, icon: string, muted: boolean) {
		set_content({ value, icon, muted })
		set_reveal(true)

		hide_timer?.cancel()
		hide_timer = timeout(options.osd.dismiss.peek(), () => {
			set_reveal(false)
		})
	}

	type audio_endpoint = ReturnType<typeof audio.get_default_speaker>

	function watch_endpoint(
		get_endpoint: () => audio_endpoint,
		default_changed_signal: string,
	) {
		let endpoint: audio_endpoint | null = null
		let endpoint_handlers: number[] = []

		const disconnect_endpoint = () => {
			if (endpoint)
				for (const handler of endpoint_handlers) endpoint.disconnect(handler)
			endpoint = null
			endpoint_handlers = []
		}

		const show_endpoint = () => {
			if (!endpoint) return
			show(
				endpoint.get_volume(),
				endpoint.get_volume_icon(),
				endpoint.get_mute(),
			)
		}

		const reconnect_endpoint = () => {
			disconnect_endpoint()
			endpoint = get_endpoint()
			if (!endpoint) return
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

	function watch_brightness(
		property: "display" | "kbd",
		kind: "screen" | "keyboard",
	) {
		const handler = brightness.connect(`notify::${property}`, () => {
			if (!brightness.initialized) return
			const level = brightness[property]
			show(level, get_brightness_icon(level, kind), false)
		})
		return () => brightness.disconnect(handler)
	}

	function connect_listeners() {
		const disconnect_speaker = watch_endpoint(
			() => audio.get_default_speaker(),
			"notify::default-speaker",
		)
		const disconnect_microphone = watch_endpoint(
			() => audio.get_default_microphone(),
			"notify::default-microphone",
		)
		const disconnect_display = watch_brightness("display", "screen")
		const disconnect_keyboard = watch_brightness("kbd", "keyboard")

		return () => {
			disconnect_speaker()
			disconnect_microphone()
			disconnect_display()
			disconnect_keyboard()
		}
	}
}
