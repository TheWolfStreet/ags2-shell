import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import { Accessor, createBinding, For, With } from "ags"

import AstalWp from "gi://AstalWp"
import Pango from "gi://Pango"

import { Arrow, Menu, SettingsButton } from "./MenuControls"

import icons, { substitute_icon_name } from "$lib/icons"
import { notify_missing_programs } from "$lib/notifications"
import { attempt_async, log_error } from "$lib/result"
import type { maybe_accessor } from "$lib/ui"

const audio = AstalWp.get_default()
const { CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { EllipsizeMode } = Pango
const { STREAM_OUTPUT_AUDIO, AUDIO_SINK } = AstalWp.MediaClass

async function open_audio_settings() {
	if (!notify_missing_programs("pavucontrol")) return
	log_error(
		await attempt_async(() => execAsync(["pavucontrol"])),
		"audio.settings: Failed to open pavucontrol",
	)
}

function media_nodes(media_class: AstalWp.MediaClass) {
	return createBinding(audio, "nodes").as((nodes) =>
		(nodes ?? []).filter((node) => node.get_media_class() === media_class),
	)
}

function AudioMenu({
	name,
	title,
	iconName: icon_name,
	children,
}: {
	name: string
	title: string
	iconName: string
	children: JSX.Element
}) {
	return (
		<Menu name={name} title={title} iconName={icon_name}>
			<box orientation={VERTICAL}>
				<box orientation={VERTICAL}>{children}</box>
				<Gtk.Separator />
				<SettingsButton callback={() => void open_audio_settings()} />
			</box>
		</Menu>
	)
}

export namespace Audio {
	export function AppMixer() {
		return (
			<AudioMenu
				name="app-mixer"
				title="App Mixer"
				iconName={icons.audio.mixer}
			>
				<For each={media_nodes(STREAM_OUTPUT_AUDIO)}>
					{(stream: AstalWp.Node) => <MixerEntry node={stream} />}
				</For>
			</AudioMenu>
		)
	}

	export function SinkSelector() {
		const sinks = media_nodes(AUDIO_SINK).as((nodes) =>
			nodes.filter((node) => node instanceof AstalWp.Endpoint),
		)
		return (
			<AudioMenu
				name="device-selector"
				title="Device Selector"
				iconName={icons.audio.devices}
			>
				<For each={sinks}>
					{(endpoint: AstalWp.Endpoint) => <SinkEntry endpoint={endpoint} />}
				</For>
			</AudioMenu>
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
			const has_sink = media_nodes(AUDIO_SINK).as((sinks) => sinks.length > 0)
			const has_stream = media_nodes(STREAM_OUTPUT_AUDIO).as(
				(streams) => streams.length > 0,
			)

			return (
				<box>
					<ControlUnit device={speaker} />
					<box class="volume" valign={CENTER} visible={has_sink}>
						<Arrow name="device-selector" tooltipText="Device Selector" />
						<Arrow
							name="app-mixer"
							visible={has_stream}
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
			show?: maybe_accessor<boolean>
		}) {
			return (
				<With value={device}>
					{(node: AstalWp.Node | null) => {
						if (!node) return <box visible={false} />

						const volume = createBinding(node, "volume")
						const volume_tooltip = volume.as(
							(level) => `Volume: ${Math.floor((level ?? 0) * 100)}%`,
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
									value={volume}
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

	function MixerEntry({ node }: { node: AstalWp.Node }) {
		const name = createBinding(node, "name")
		return (
			<box hexpand class="mixer-item horizontal">
				<image
					iconName={name.as((value) => substitute_icon_name(value ?? ""))}
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
						label={name.as((value) => value || "")}
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
