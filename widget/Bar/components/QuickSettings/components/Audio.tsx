import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import { Accessor, createBinding, For, With } from "ags"

import AstalWp from "gi://AstalWp"
import Pango from "gi://Pango"

import { Arrow, Menu, SettingsButton } from "./MenuControls"

import icons, { substitute_icon_name } from "$lib/icons"
import { notify_missing_programs } from "$lib/notifications"
import { attempt_async, log_error } from "$lib/result"

const audio = AstalWp.get_default()
async function open_audio_settings() {
	if (!notify_missing_programs("pavucontrol")) return
	log_error(
		await attempt_async(() => execAsync(["pavucontrol"])),
		"audio.settings: Failed to open pavucontrol",
	)
}

export namespace Audio {
	export function AppMixer() {
		const app_streams = createBinding(audio, "nodes").as((audio_nodes) =>
			(audio_nodes ?? []).filter(
				(node) => node.get_media_class() === STREAM_OUTPUT_AUDIO,
			),
		)
		return (
			<Menu name="app-mixer" title="App Mixer" iconName={icons.audio.mixer}>
				<box orientation={VERTICAL}>
					<box orientation={VERTICAL}>
						<For each={app_streams}>
							{(app_stream: AstalWp.Node) => <MixerEntry node={app_stream} />}
						</For>
					</box>
					<Gtk.Separator />
					<SettingsButton callback={() => void open_audio_settings()} />
				</box>
			</Menu>
		)
	}

	export function SinkSelector() {
		const sinks = createBinding(audio, "nodes").as((audio_nodes) =>
			(audio_nodes ?? []).filter(
				(node): node is AstalWp.Endpoint =>
					node instanceof AstalWp.Endpoint &&
					node.get_media_class() === AUDIO_SINK,
			),
		)
		return (
			<Menu
				name="device-selector"
				title="Device Selector"
				iconName={icons.audio.devices}
			>
				<box orientation={VERTICAL}>
					<box orientation={VERTICAL}>
						<For each={sinks}>
							{(endpoint: AstalWp.Endpoint) => (
								<SinkEntry endpoint={endpoint} />
							)}
						</For>
					</box>
					<Gtk.Separator />
					<SettingsButton callback={() => void open_audio_settings()} />
				</box>
			</Menu>
		)
	}

	export namespace State {
		export function Speaker() {
			return <Endpoint binding={createBinding(audio, "defaultSpeaker")} />
		}

		export function Microphone() {
			return <Endpoint binding={createBinding(audio, "defaultMicrophone")} />
		}

		function Endpoint({
			binding,
		}: {
			binding: Accessor<AstalWp.Endpoint | null>
		}) {
			return (
				<With value={binding}>
					{(endpoint: AstalWp.Endpoint | null) => {
						if (!endpoint) return <box visible={false} />
						return (
							<image
								iconName={createBinding(endpoint, "volumeIcon")}
								useFallback
							/>
						)
					}}
				</With>
			)
		}
	}

	export namespace Sliders {
		export function Volume() {
			const speaker = createBinding(audio, "defaultSpeaker")

			const has_audio_speaker = createBinding(audio, "nodes").as(
				(audio_nodes) =>
					(audio_nodes ?? []).some(
						(node) => node.get_media_class() === AUDIO_SINK,
					),
			)

			const has_audio_stream = createBinding(audio, "nodes").as((audio_nodes) =>
				(audio_nodes ?? []).some(
					(node) => node.get_media_class() === STREAM_OUTPUT_AUDIO,
				),
			)

			return (
				<box>
					<ControlUnit device={speaker} />
					<box class="volume" valign={CENTER} visible={has_audio_speaker}>
						<Arrow name="device-selector" tooltipText="Device Selector" />
						<Arrow
							name="app-mixer"
							visible={has_audio_stream}
							tooltipText="App Mixer"
						/>
					</box>
				</box>
			)
		}

		export function Microphone() {
			const has_devices = createBinding(audio, "devices").as(
				(devices) => (devices?.length ?? 0) > 0,
			)
			const mic = createBinding(audio, "defaultMicrophone")
			return <ControlUnit device={mic} show={has_devices} />
		}

		function ControlUnit({
			device,
			show = true,
		}: {
			device: Accessor<AstalWp.Node | null>
			show?: Accessor<boolean> | boolean
		}) {
			return (
				<With value={device}>
					{(node: AstalWp.Node | null) => {
						if (!node) return <box visible={false} />

						const volume_tooltip = createBinding(node, "volume").as(
							(volume) => `Volume: ${Math.floor((volume ?? 0) * 100)}%`,
						)

						return (
							<box class="control-unit" visible={show}>
								<button
									valign={CENTER}
									onClicked={() => node.set_mute(!node.get_mute())}
									tooltipText={volume_tooltip}
								>
									<image
										iconName={createBinding(node, "volumeIcon")}
										useFallback
									/>
								</button>
								<slider
									hexpand
									drawValue={false}
									value={createBinding(node, "volume")}
									class={createBinding(node, "mute").as((muted) =>
										muted ? "muted" : "",
									)}
									onChangeValue={({ value }) => {
										node.set_volume(value)
										node.set_mute(false)
									}}
								/>
							</box>
						)
					}}
				</With>
			)
		}
	}

	const { CENTER, END } = Gtk.Align
	const { VERTICAL } = Gtk.Orientation
	const { EllipsizeMode } = Pango
	const { STREAM_OUTPUT_AUDIO, AUDIO_SINK } = AstalWp.MediaClass

	function MixerEntry({ node }: { node: AstalWp.Node }) {
		return (
			<box hexpand class="mixer-item horizontal">
				<image
					iconName={createBinding(node, "name").as((name) =>
						substitute_icon_name(name ?? ""),
					)}
					tooltipText={createBinding(node, "description").as(
						(description) => description || "",
					)}
					useFallback
				/>
				<box orientation={VERTICAL}>
					<label
						xalign={0}
						maxWidthChars={28}
						ellipsize={EllipsizeMode.END}
						label={createBinding(node, "name").as((name) => name || "")}
					/>
					<slider
						hexpand
						drawValue={false}
						value={createBinding(node, "volume")}
						onChangeValue={({ value }) => {
							node.volume = value
						}}
					/>
				</box>
			</box>
		)
	}

	function SinkEntry({ endpoint }: { endpoint: AstalWp.Endpoint }) {
		const is_default_speaker = createBinding(audio, "defaultSpeaker").as(
			(speaker) => speaker === endpoint,
		)

		return (
			<button hexpand onClicked={() => endpoint.set_is_default(true)}>
				<box class="sink-item horizontal">
					<image
						iconName={createBinding(endpoint, "icon").as((icon) =>
							substitute_icon_name(icon),
						)}
						tooltipText={createBinding(endpoint, "name").as(
							(name) => name ?? "",
						)}
						useFallback
					/>
					<label
						label={(endpoint.description || "")
							.split(" ")
							.slice(0, 4)
							.join(" ")}
					/>
					<image
						iconName={icons.ui.tick}
						hexpand
						halign={END}
						visible={is_default_speaker}
						useFallback
					/>
				</box>
			</button>
		)
	}
}
