import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import { Accessor, createBinding, For, With } from "ags"

import AstalWp from "gi://AstalWp"
import Pango from "gi://Pango"

import { Arrow, Menu, Settings } from "./shared/MenuElements"

import icons, { getIcon } from "$lib/icons"
import { audio } from "$lib/services"
import { dependencies } from "$lib/utils"

const { CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

const { AUDIO_SOURCE, STREAM_OUTPUT_AUDIO, AUDIO_SINK } = AstalWp.MediaClass

export namespace Audio {
	function MixerEntry({ node }: { node: AstalWp.Node }) {
		return (
			<box hexpand class="mixer-item horizontal">
				<image
					iconName={createBinding(node, "name").as(name => getIcon(name))}
					tooltipText={createBinding(node, "description").as((d) => d || "")}
					useFallback
				/>
				<box orientation={VERTICAL}>
					<label
						xalign={0}
						maxWidthChars={28}
						ellipsize={Pango.EllipsizeMode.END}
						label={createBinding(node, "name").as((n) => n || "")}
					/>
					<slider
						hexpand
						drawValue={false}
						value={createBinding(node, "volume")}
						onNotifyValue={({ value }) => (node.volume = value)}
					/>
				</box>
			</box>
		)
	}

	function SinkEntry({ endpoint }: { endpoint: AstalWp.Endpoint }) {
		return (
			<button hexpand onClicked={() => (endpoint.set_is_default(true))}>
				<box class="sink-item horizontal">
					<image
						iconName={createBinding(endpoint, "icon").as(icon => getIcon(icon))}
						tooltipText={createBinding(endpoint, "name")}
						useFallback
					/>
					<label label={(endpoint.description || "").split(" ").slice(0, 4).join(" ")} />
					<image
						iconName={icons.ui.tick}
						hexpand
						halign={END}
						visible={(audio && createBinding(audio.defaultSpeaker, "description").as(s => s === endpoint.description)) ?? undefined}
						useFallback
					/>
				</box>
			</button>
		)
	}

	export function AppMixer() {
		const nodes = createBinding(audio, "nodes").as((a) => a.filter((item) => item.get_media_class() === STREAM_OUTPUT_AUDIO))
		return (
			<Menu name="app-mixer" title="App Mixer" iconName={icons.audio.mixer}>
				<box orientation={VERTICAL}>
					<box orientation={VERTICAL}>
						<For each={nodes}>
							{(n: AstalWp.Node) => (
								<MixerEntry node={n} />
							)}
						</For>
					</box>
					<Gtk.Separator />
					<Settings callback={() => dependencies("pavucontrol") && execAsync("pavucontrol")} />
				</box>
			</Menu>
		)
	}

	export function SinkSelector() {
		const nodes = createBinding(audio, "nodes").as(nodes => nodes.filter((n): n is AstalWp.Endpoint => n instanceof AstalWp.Endpoint && n.get_media_class() === AUDIO_SINK))
		return (
			<Menu name="device-selector" title="Device Selector" iconName={icons.audio.devices}>
				<box orientation={VERTICAL}>
					<box orientation={VERTICAL}>
						<For each={nodes}>
							{(endpoint: AstalWp.Endpoint) => (
								<SinkEntry endpoint={endpoint} />
							)}
						</For>
					</box>
					<Gtk.Separator />
					<Settings callback={() => dependencies("pavucontrol") && execAsync("pavucontrol")} />
				</box>
			</Menu>
		)
	}

	export namespace State {
		function Endpoint({ binding }: { binding: Accessor<AstalWp.Endpoint | null> }) {
			return (
				<With value={binding}>
					{(ep: AstalWp.Endpoint | null) =>
						ep
							? <image iconName={createBinding(ep, "volumeIcon")} useFallback />
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
			device: AstalWp.Node | undefined,
			show?: Accessor<boolean> | boolean
		}) {
			if (!device) return <box visible={false} />
			return (
				<box class="control-unit" visible={show}>
					<button valign={CENTER} onClicked={() => device.set_mute(!device.get_mute())}
						tooltipText={createBinding(device, "volume").as(v => `Volume: ${Math.floor((v ?? 0) * 100)}%`)}>
						<image iconName={createBinding(device, "volumeIcon")} useFallback />
					</button>
					<slider
						hexpand
						draw_value={false}
						value={createBinding(device, "volume")}
						class={createBinding(device, "mute").as(v => v ? "muted" : "")}
						onNotifyValue={({ value }) => {
							device.set_volume(value)
							device.set_mute(false)
						}}
					/>
				</box>
			)
		}

		export function Volume() {
			const speaker = audio?.defaultSpeaker;

			const hasAudioSpeaker = audio
				? createBinding(audio, "nodes").as(nodes =>
					nodes.some(node => node.get_media_class() === AUDIO_SOURCE)
				)
				: false;

			const hasAudioStream = audio
				? createBinding(audio, "nodes").as(nodes =>
					nodes.some(node => node.get_media_class() === STREAM_OUTPUT_AUDIO)
				)
				: false;

			return (
				<box>
					<ControlUnit device={speaker} />
					<box class="volume" valign={CENTER} visible={hasAudioSpeaker}>
						<Arrow name="device-selector" tooltipText="Device Selector" />
						<Arrow name="app-mixer" visible={hasAudioStream} tooltipText="App Mixer" />
					</box>
				</box>
			);
		}

		export function Microphone() {
			const hasDevices = createBinding(audio, "devices").as(a => a.length > 0)
			const mic = audio.get_default_microphone()
			return <ControlUnit device={mic} show={hasDevices} />
		}
	}
}

