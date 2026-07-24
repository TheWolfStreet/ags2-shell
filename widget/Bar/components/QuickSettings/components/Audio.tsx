// Lists audio devices and apps and shows volume, mute, and mixer controls.

import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import { Accessor, createBinding, For, With } from "ags"

import AstalWp from "gi://AstalWp"
import Pango from "gi://Pango"

import { MediaPlayer as MprisMediaPlayer } from "./MediaPlayer"
import { Arrow, Menu, SettingsButton } from "./MenuControls"

import icons, { substituteIconName } from "$lib/icons"
import { audio } from "$service/astal"
import { requirePrograms } from "$lib/programs"

const { CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { EllipsizeMode } = Pango
const { STREAM_OUTPUT_AUDIO, AUDIO_SINK } = AstalWp.MediaClass

export namespace Audio {
	export const MediaPlayer = MprisMediaPlayer

	function MixerEntry({ node }: { node: AstalWp.Node }) {
		return (
			<box hexpand class="mixer-item horizontal">
				<image
					iconName={createBinding(node, "name").as(name => substituteIconName(name))}
					tooltipText={createBinding(node, "description").as(description => description || "")}
					useFallback
				/>
				<box orientation={VERTICAL}>
					<label
						xalign={0}
						maxWidthChars={28}
						ellipsize={EllipsizeMode.END}
						label={createBinding(node, "name").as(name => name || "")}
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
		const isDefaultSpeaker = createBinding(audio, "defaultSpeaker").as(
			speaker => speaker?.description === endpoint.description,
		)

		return (
			<button hexpand onClicked={() => (endpoint.set_is_default(true))}>
				<box class="sink-item horizontal">
					<image
						iconName={createBinding(endpoint, "icon").as(icon => substituteIconName(icon))}
						tooltipText={createBinding(endpoint, "name")}
						useFallback
					/>
					<label label={(endpoint.description || "").split(" ").slice(0, 4).join(" ")} />
					<image
						iconName={icons.ui.tick}
						hexpand
						halign={END}
						visible={isDefaultSpeaker}
						useFallback
					/>
				</box>
			</button>
		)
	}

	export function AppMixer() {
		const appStreams = createBinding(audio, "nodes").as(audioNodes =>
			audioNodes.filter(node => node.get_media_class() === STREAM_OUTPUT_AUDIO)
		)
		return (
			<Menu name="app-mixer" title="App Mixer" iconName={icons.audio.mixer}>
				<box orientation={VERTICAL}>
					<box orientation={VERTICAL}>
						<For each={appStreams}>
							{(appStream: AstalWp.Node) => (
								<MixerEntry node={appStream} />
							)}
						</For>
					</box>
					<Gtk.Separator />
					<SettingsButton callback={() => requirePrograms("pavucontrol") && execAsync(["pavucontrol"])} />
				</box>
			</Menu>
		)
	}

	export function SinkSelector() {
		const sinks = createBinding(audio, "nodes").as(audioNodes =>
			audioNodes.filter((node): node is AstalWp.Endpoint =>
				node instanceof AstalWp.Endpoint && node.get_media_class() === AUDIO_SINK
			)
		)
		return (
			<Menu name="device-selector" title="Device Selector" iconName={icons.audio.devices}>
				<box orientation={VERTICAL}>
					<box orientation={VERTICAL}>
						<For each={sinks}>
							{(endpoint: AstalWp.Endpoint) => (
								<SinkEntry endpoint={endpoint} />
							)}
						</For>
					</box>
					<Gtk.Separator />
					<SettingsButton callback={() => requirePrograms("pavucontrol") && execAsync(["pavucontrol"])} />
				</box>
			</Menu>
		)
	}

	export namespace State {
		function Endpoint({ binding }: { binding: Accessor<AstalWp.Endpoint | null> }) {
			return (
				<With value={binding}>
					{(endpoint: AstalWp.Endpoint | null) =>
						endpoint
							? <image iconName={createBinding(endpoint, "volumeIcon")} useFallback />
							: <box visible={false} />
					}
				</With>
			)
		}
		export function Speaker() {
			return (
				<Endpoint binding={createBinding(audio, "defaultSpeaker")} />
			)
		}

		export function Microphone() {
			return (
				<Endpoint binding={createBinding(audio, "defaultMicrophone")} />
			)
		}
	}

	export namespace Sliders {
		function ControlUnit({
			device,
			show = true,
		}: {
			device: Accessor<AstalWp.Node | null>,
			show?: Accessor<boolean> | boolean
		}) {
			return (
				<With value={device}>
					{(node: AstalWp.Node | null) => {
						if (!node) return <box visible={false} />

						const volumeTooltip = createBinding(node, "volume").as(volume => `Volume: ${Math.floor((volume ?? 0) * 100)}%`)

						return (
							<box class="control-unit" visible={show}>
								<button valign={CENTER} onClicked={() => node.set_mute(!node.get_mute())}
									tooltipText={volumeTooltip}>
									<image iconName={createBinding(node, "volumeIcon")} useFallback />
								</button>
								<slider
									hexpand
									drawValue={false}
									value={createBinding(node, "volume")}
									class={createBinding(node, "mute").as(muted => muted ? "muted" : "")}
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

		export function Volume() {
			const speaker = createBinding(audio, "defaultSpeaker")

			const hasAudioSpeaker = createBinding(audio, "nodes").as(audioNodes =>
				audioNodes.some(node => node.get_media_class() === AUDIO_SINK)
			)

			const hasAudioStream = createBinding(audio, "nodes").as(audioNodes =>
				audioNodes.some(node => node.get_media_class() === STREAM_OUTPUT_AUDIO)
			)

			return (
				<box>
					<ControlUnit device={speaker} />
					<box class="volume" valign={CENTER} visible={hasAudioSpeaker}>
						<Arrow name="device-selector" tooltipText="Device Selector" />
						<Arrow name="app-mixer" visible={hasAudioStream} tooltipText="App Mixer" />
					</box>
				</box>
			)
		}

		export function Microphone() {
			const hasDevices = createBinding(audio, "devices").as(devices => devices.length > 0)
			const mic = createBinding(audio, "defaultMicrophone")
			return <ControlUnit device={mic} show={hasDevices} />
		}
	}
}
