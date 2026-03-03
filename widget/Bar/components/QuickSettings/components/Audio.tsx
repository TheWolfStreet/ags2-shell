import { Gdk, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import { Accessor, createBinding, createComputed, For, With } from "ags"

import AstalWp from "gi://AstalWp"
import Pango from "gi://Pango"

import { Arrow, Menu, Settings } from "./shared/MenuElements"

import icons, { getIcon } from "$lib/icons"
import { audio } from "$lib/services"
import { dependencies, formatClock } from "$lib/utils"
import { textureFromUriSquareContainAsync } from "$lib/textures"
import AstalMpris from "gi://AstalMpris"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit
const { EllipsizeMode } = Pango
const { STREAM_OUTPUT_AUDIO, AUDIO_SINK } = AstalWp.MediaClass

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
						ellipsize={EllipsizeMode.END}
						label={createBinding(node, "name").as((n) => n || "")}
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
						iconName={createBinding(endpoint, "icon").as(icon => getIcon(icon))}
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

	export function MediaPlayer({ player }: { player: AstalMpris.Player }) {
		const { PLAYING } = AstalMpris.PlaybackStatus
		const { PLAYLIST, TRACK, NONE } = AstalMpris.Loop
		const { ON, OFF } = AstalMpris.Shuffle

		const title = createBinding(player, "title").as(t => t || "Untitled")
		const artist = createBinding(player, "artist").as(a => a || "Unknown Artist")
		const cover = createBinding(player, "coverArt")
		const hasCover = cover.as(url => Boolean(url?.trim()))
		const coverTexture = createComputed(() => textureFromUriSquareContainAsync(cover() || "", 100)())
		const textMaxWidth = 20
		const icon = createBinding(player, "entry").as(e => e || "audio-x-generic-symbolic")
		const posNorm = createBinding(player, "position").as(p => player.length > 0 ? p / player.length : 0)
		const pos = createBinding(player, "position")
		const status = createBinding(player, "playbackStatus")
		const loop = createBinding(player, "loopStatus")
		const shuffle = createBinding(player, "shuffleStatus")
		const len = createBinding(player, "length")
		const control = createBinding(player, "canControl")
		const next = createBinding(player, "canGoNext")
		const prev = createBinding(player, "canGoPrevious")

		const remaining = createComputed(() => Math.max(0, len() - pos()))

		const playIcon = status.as(s => s === PLAYING ? icons.mpris.playing : icons.mpris.paused)
		const loopIcon = loop.as(s => {
			switch (s) {
				case NONE: return icons.mpris.loop.none
				case TRACK: return icons.mpris.loop.track
				case PLAYLIST: return icons.mpris.loop.playlist
				default: return icons.mpris.loop.none
			}
		})
		const loopHint = createBinding(player, "loopStatus").as((v) => {
			switch (v) {
				case NONE: return "Loop: Disabled"
				case PLAYLIST: return "Loop: Playlist"
				case TRACK: return "Loop: Track"
				default: return "Loop: Disabled"
			}
		})

		function cycleLoop() {
			switch (player.loopStatus) {
				case NONE: player.set_loop_status(PLAYLIST); break
				case PLAYLIST: player.set_loop_status(TRACK); break
				case TRACK: player.set_loop_status(NONE); break
				default: break
			}
		}

		function cycleShuffle() {
			switch (player.shuffleStatus) {
				case OFF: player.set_shuffle_status(ON); break
				case ON: player.set_shuffle_status(OFF); break
				default: break
			}
		}
		let lastUpdate = 0

		return (
			<box class="player" vexpand={false}>
				<Gtk.Picture
					class="cover-art"
					visible={hasCover}
					widthRequest={100}
					heightRequest={100}
					halign={CENTER}
					valign={CENTER}
					paintable={coverTexture.as(t => t as Gdk.Paintable)}
					contentFit={COVER}
				/>

				<box orientation={VERTICAL}>
					<box class="title horizontal">
						<label
							label={title}
							halign={START}
							wrap hexpand
							maxWidthChars={textMaxWidth}
						/>
						<image iconName={icon} useFallback />
					</box>
					<label
						class="artist"
						label={artist}
						halign={START}
						valign={START}
						wrap vexpand
						maxWidthChars={textMaxWidth}
					/>
					<slider
						tooltipText={len.as(v => (v > 0) ? `Duration: ${formatClock(v)}` : "")}
						visible={len.as(l => l > 0)}
						onChangeValue={({ value }) => {
							const now = Date.now()
							if (now - lastUpdate < 100) return
							lastUpdate = now
							player.position = value * player.length
						}}
						value={posNorm}
					/>
					<box class="horizontal">
						<label
							hexpand
							class="position"
							halign={START}
							visible={len.as(l => l > 0)}
							label={pos.as(formatClock)}
						/>
						<box hexpand halign={CENTER}>
							<button
								class={shuffle.as(s => s === ON ? "active" : "")}
								onClicked={cycleShuffle}
								visible={shuffle.as(s => s != AstalMpris.Shuffle.UNSUPPORTED)}>
								<image iconName={icons.mpris.shuffle} useFallback />
							</button>
							<button onClicked={() => player.previous()} visible={prev}>
								<image iconName={icons.mpris.prev} useFallback />
							</button>
							<button class="play-pause" onClicked={() => player.play_pause()} visible={control}>
								<image iconName={playIcon} useFallback />
							</button>
							<button onClicked={() => player.next()} visible={next}>
								<image iconName={icons.mpris.next} useFallback />
							</button>
							<button
								class={loop.as(s => s !== NONE && s !== AstalMpris.Loop.UNSUPPORTED ? "active" : "")}
								tooltipText={loopHint}
								onClicked={cycleLoop}
								visible={loop.as(s => s != AstalMpris.Loop.UNSUPPORTED)}
							>
								<image iconName={loopIcon} useFallback />
							</button>
						</box>
						<label
							class="length"
							hexpand
							halign={END}
							visible={len.as(l => l > 0)}
							label={remaining.as(formatClock)}
						/>
					</box>
				</box>
			</box>
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
			device: Accessor<AstalWp.Node | null>,
			show?: Accessor<boolean> | boolean
		}) {
			return (
				<With value={device}>
					{(node: AstalWp.Node | null) => {
						if (!node) return <box visible={false} />

						const volumeTooltip = createBinding(node, "volume").as(v => `Volume: ${Math.floor((v ?? 0) * 100)}%`)

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
									class={createBinding(node, "mute").as(v => v ? "muted" : "")}
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

			const hasAudioSpeaker = audio
				? createBinding(audio, "nodes").as(nodes =>
					nodes.some(node => node.get_media_class() === AUDIO_SINK)
				)
				: false

			const hasAudioStream = audio
				? createBinding(audio, "nodes").as(nodes =>
					nodes.some(node => node.get_media_class() === STREAM_OUTPUT_AUDIO)
				)
				: false

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
			const hasDevices = createBinding(audio, "devices").as(a => a.length > 0)
			const mic = createBinding(audio, "defaultMicrophone")
			return <ControlUnit device={mic} show={hasDevices} />
		}
	}
}
