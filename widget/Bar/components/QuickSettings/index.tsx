import { Accessor, createBinding, createComputed, createState, For, Node, onCleanup, With } from "ags"
import app from "ags/gtk4/app"
import { execAsync, exec } from "ags/process"
import { timeout } from "ags/time"
import { Astal, Gdk, Gtk } from "ags/gtk4"

import AstalMpris from "gi://AstalMpris"
import AstalWp from "gi://AstalWp"
import AstalNetwork from "gi://AstalNetwork"
import AstalHyprland from "gi://AstalHyprland"
import AstalBluetooth from "gi://AstalBluetooth"
import GdkPixbuf from "gi://GdkPixbuf"
import Pango from "gi://Pango"

import { Placeholder } from "widget/shared/Placeholder"
import PopupWindow, { Position } from "widget/shared/PopupWindow"
import { Arrow, ArrowToggleButton, Menu, opened, set_opened, SimpleToggleButton } from "./ToggleButton"

import { env } from "$lib/env"
import icons from "$lib/icons"
import { bash, dependencies, duration, launchApp, lookupIconName, toggleClass, fileExists } from "$lib/utils"
import { asusctl, audio, brightness, bt, hypr, media, net, notifd, pp } from "$lib/services"

import { Asusctl } from "$service/asusctl"

import options from "options"

const { bar, quicksettings } = options
const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER, SCALE_DOWN } = Gtk.ContentFit
const { BILINEAR } = GdkPixbuf.InterpType


const { AUDIO_SOURCE, STREAM_OUTPUT_AUDIO, AUDIO_SINK } = AstalWp.MediaClass
const { NEVER } = Gtk.PolicyType

const layout = createComputed([bar.position, quicksettings.position], (bar, qs) => `${bar}-${qs}` as Position)

const { scheme } = options.theme

function Settings({ callback: callback }: { callback: () => void }) {
	return (
		<button onClicked={callback} hexpand>
			<box class="settings horizontal">
				<image iconName={icons.ui.settings} useFallback />
				<label label={"Settings"} />
			</box>
		</button>
	)
}

namespace Audio {
	function MixerItem({ node }: { node: AstalWp.Node }) {
		return (
			<box hexpand class="mixer-item horizontal">
				<image
					iconName={createBinding(node, "name")}
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

	function SinkItem({ endpoint }: { endpoint: AstalWp.Endpoint }) {
		return (
			<button hexpand onClicked={() => (endpoint.set_is_default(true))}>
				<box class="sink-item horizontal">
					<image
						iconName={createBinding(endpoint, "icon")}
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
								<MixerItem node={n} />
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
			<Menu name="device-selector" title="Device Selector" iconName={icons.audio.type.headset}>
				<box orientation={VERTICAL}>
					<box orientation={VERTICAL}>
						<For each={nodes}>
							{(endpoint: AstalWp.Endpoint) => (
								<SinkItem endpoint={endpoint} />
							)}
						</For>
					</box>
					<Gtk.Separator />
					<Settings callback={() => dependencies("pavucontrol") && execAsync("pavucontrol")} />
				</box>
			</Menu>
		)
	}
}

namespace Profiles {
	function prettify(str: string) {
		return str
			.split("-")
			.map((str) => `${str.at(0)?.toUpperCase()}${str.slice(1)}`)
			.join(" ")
	}

	interface Provider {
		getActive: () => Accessor<string>,
		getProfiles: () => string[],
		setActive: (p: string) => void,
		iconFor: (p: string) => string,
		labelFor: (p: string) => string,
		extraSettings?: Node,
		toggleDefaults: () => [string, string]
	}
	const asusProvider: Provider = {
		getActive: () => createBinding(asusctl, "profile"),
		getProfiles: () => asusctl.profiles,
		// @ts-ignore: Valid keys
		setActive: (p: Asusctl.Profile) => { asusctl.profile = p },
		// @ts-ignore: Valid keys
		iconFor: (p) => icons.asusctl.profile[p],
		labelFor: (p) => p,
		extraSettings: <Settings callback={() => launchApp("rog-control-center")} />,
		toggleDefaults: () => ["Quiet", "Balanced"],
	}

	const powerProvider: Provider | undefined = pp?.version ? {
		getActive: () => createBinding(pp, "activeProfile"),
		getProfiles: () => pp.get_profiles().map(p => p.profile),
		setActive: (p) => pp.set_active_profile(p),
		// @ts-ignore: Valid keys
		iconFor: (p) => icons.powerprofile[p],
		labelFor: (p) => prettify(p),
		toggleDefaults: () => {
			const profiles = pp.get_profiles()
			if (profiles.length >= 2) {
				return [profiles[0].profile, profiles[1].profile]
			}
			return ["", ""]
		},
	} : undefined

	function makeToggle(provider: Provider) {
		const active = provider.getActive()
		const [on, off] = provider.toggleDefaults()

		return (
			<ArrowToggleButton
				name="profile-selector"
				iconName={active.as(p => provider.iconFor(p))}
				label={active.as(p => provider.labelFor(p))}
				activate={() => provider.setActive(on)}
				deactivate={() => provider.setActive(off)}
				connection={active.as(p => p !== off)}
			/>
		)
	}

	function makeSelector(provider: Provider) {
		const active = provider.getActive()
		const profiles = provider.getProfiles()
		return (
			<Menu name="profile-selector" iconName={active.as(p => provider.iconFor(p))} title="Profile Selector">
				<box orientation={VERTICAL} hexpand>
					{profiles.map(p => (
						<button onClicked={() => provider.setActive(p)}>
							<box class="profile-item horizontal">
								<image iconName={provider.iconFor(p)} />
								<label label={provider.labelFor(p)} />
							</box>
						</button>
					))}
					{provider.extraSettings && (
						<>
							<Gtk.Separator />
							{provider.extraSettings}
						</>
					)}
				</box>
			</Menu>
		)
	}

	function MissingToggle() {
		return (
			<ArrowToggleButton
				name="missing-profile"
				iconName={icons.missing}
				label="No Provider"
			/>
		)
	}

	function MissingSelector() {
		return (
			<Menu name="missing-profile" iconName={icons.missing} title="Install asusctl or powerprofiles daemon">
				<Placeholder iconName={icons.missing} label="No power profile provider found" />
			</Menu>
		)
	}

	const provider = asusctl.available ? asusProvider : powerProvider

	export const Toggle = provider ? () => makeToggle(provider) : MissingToggle
	export const Selector = provider ? () => makeSelector(provider) : MissingSelector
}

namespace Bluetooth {
	function Item({ device }: { device: AstalBluetooth.Device }) {
		const connecting = createBinding(device, "connecting")
		const label = createComputed(
			[
				createBinding(device, "name"),
				createBinding(device, "address"),
				createBinding(device, "batteryPercentage"),
				createBinding(device, "paired")
			],
			(name, address, battery, paired) => {
				const displayName = name ?? address
				const bat = paired && battery != undefined
					? ` ${(battery * 100)}%`.replace(/-/g, "")
					: ""
				const isPaired = paired ? " • Paired" : ""
				return `${displayName}${bat}${isPaired}`
			}
		)

		let btn: Gtk.Button

		return (
			<button $={self => (btn = self)} tooltipText={createBinding(device, "paired").as(p => p ? "Right-click to unpair" : "")}>
				<Gtk.GestureClick
					button={0}
					onPressed={self => {
						const mBtn = self.get_current_button()
						switch (mBtn) {
							case Gdk.BUTTON_PRIMARY:
								device[device.get_connected() ? "disconnect_device" : "connect_device"](() =>
									toggleClass(btn, "active", !device.get_connected())
								)
								break
							case Gdk.BUTTON_SECONDARY:
								if (device.paired) {
									bash`bluetoothctl remove ${device.get_address()}`
								}
								break
						}
						self.reset()
					}}
				/>

				<box class="bluetooth-item horizontal">
					<image iconName={createBinding(device, "icon").as(i => i + "-symbolic")} />
					<label label={label} />
					<box hexpand />
					<Gtk.Spinner spinning={connecting} visible={connecting} />
				</box>
			</button>
		)
	}

	export function Toggle() {
		const powered = createBinding(bt, "isPowered")
		const connected = createBinding(bt, "isConnected")
		const adapters = createBinding(bt, "adapters")

		const label = createComputed([powered, connected, adapters], (p, c, a) => {
			if (a.length == 0) return "No Device"
			if (!p) return "Disabled"
			if (c) return bt.devices.filter(d => d.connected).at(0)?.name ?? ""
			return "Not Connected"
		})

		return (
			<ArrowToggleButton
				name="bluetooth-selector"
				label={label}
				iconName={powered.as(p => p ? icons.bluetooth.enabled : icons.bluetooth.disabled)}
				activateOnArrow={true}
				activate={() => !powered.get() && bt.toggle()}
				deactivate={() => bt.toggle()}
				connection={powered}
			/>
		)
	}

	export function Selector() {
		const adapter = createBinding(bt, "adapter")
		const devices = createBinding(bt, "devices").as(d =>
			(d ?? []).slice().sort((a, b) => {
				const aName = a.name && a.name.trim() !== ""
				const bName = b.name && b.name.trim() !== ""
				return (bName ? 1 : 0) - (aName ? 1 : 0)
			})
		)

		return (
			<Menu
				name="bluetooth-selector"
				iconName={icons.bluetooth.disabled}
				title="Bluetooth devices"
				headerChild={
					<With value={adapter}>
						{adapter => {
							if (!adapter) return <box visible={false} />

							const discovering = createBinding(adapter, "discovering")

							const onToggleDiscover = () => {
								if (!adapter.powered) adapter.set_powered(true)
								if (discovering.get()) adapter.stop_discovery()
								else adapter.start_discovery()
							}

							return (
								<centerbox hexpand>
									<button $type="end" onClicked={onToggleDiscover}>
										<label label={discovering.as(d => (d ? "Cancel" : "Scan"))} />
									</button>
								</centerbox>
							)
						}}
					</With>
				}>
				<With value={adapter}>
					{adapter => {
						if (!adapter)
							return (
								<Placeholder
									iconName={icons.bluetooth.disabled}
									label="No Device Found"
								/>
							)

						const discovering = createBinding(adapter, "discovering")
						const hasDevices = devices.as(d => d.length > 0)

						return (
							<box orientation={VERTICAL}>
								<revealer halign={CENTER} revealChild={hasDevices.as(v => !v)} transitionDuration={options.transition.duration}>
									<Placeholder
										iconName={icons.bluetooth.disabled}
										label={discovering.as(d => (d ? "Searching for devices..." : "No devices found"))}
									/>
								</revealer>
								<revealer revealChild={hasDevices} transitionDuration={options.transition.duration}>
									<Gtk.ScrolledWindow class="device-scroll" vexpand>
										<box orientation={VERTICAL} vexpand hexpand>
											<For each={devices}>
												{(dev: AstalBluetooth.Device) => <Item device={dev} />}
											</For>
										</box>
									</Gtk.ScrolledWindow>
								</revealer>
								<Gtk.Separator />
								<Settings callback={() => bash`XDG_CURRENT_DESKTOP=GNOME gnome-control-center bluetooth`} />
							</box>
						)
					}}
				</With>
			</Menu>
		)
	}
}

namespace Wifi {
	function Item({ ap }: { ap: AstalNetwork.AccessPoint }) {
		return (
			<button onClicked={() => dependencies("nmcli") && execAsync(`nmcli device wifi connect ${ap.bssid}`)}>
				<box class="wifi-item horizontal">
					<image iconName={createBinding(ap, "iconName")} />
					<label label={createBinding(ap, "ssid").as(v => v || "Hidden network")} />
					<image
						iconName={icons.ui.tick}
						hexpand
						halign={END}
						visible={createBinding(net.wifi, "activeAccessPoint").as(v => v?.bssid === ap.bssid)}
					/>
				</box>
			</button>
		)
	}

	export function Toggle() {
		const wifi = createBinding(net, "wifi")
		return (
			<With value={wifi}>
				{w => {
					if (!w) return <ArrowToggleButton name="wifi-selector" iconName={icons.wifi.offline} label={"No device"} />
					return (
						<ArrowToggleButton
							name="wifi-selector"
							iconName={createBinding(w, "iconName")}
							// TODO: Monitor mode tracking
							label={
								createBinding(w, "activeAccessPoint")
									.as(ssid => ssid?.ssid || "Not Connected")
							}
							activateOnArrow={true}
							activate={() => {
								w.set_enabled(true)
								timeout(100, () => { w.scan() })
							}}
							deactivate={() => {
								w.set_enabled(false)
							}}
							connection={createBinding(w, "enabled")}
						/>
					)
				}}
			</With>
		)
	}

	export function Selector() {
		const wifi = createBinding(net, "wifi")

		return (
			<Menu
				name="wifi-selector"
				iconName={wifi.as(w => w ? w.iconName : icons.wifi.offline)}
				title="Visible networks"
				children={
					<With value={wifi}>
						{wifi => {
							if (!wifi)
								return (
									<Placeholder
										iconName={icons.wifi.offline}
										label="No device found" />
								)

							const aps = createBinding(wifi, "accessPoints")
								.as(aps => aps.filter(ap => ap.ssid).sort((a, b) => b.strength - a.strength))
							const hasAps = aps.as(aps => aps.length > 0)

							return (
								<box orientation={VERTICAL}>
									<revealer halign={CENTER} revealChild={hasAps.as(v => !v)} transitionDuration={options.transition.duration}>
										<Placeholder
											iconName={icons.wifi.scanning}
											label={hasAps.as(v => (v ? "" : "Searching for Wi-Fi networks..."))}
										/>
									</revealer>
									<revealer revealChild={hasAps} transitionDuration={options.transition.duration}>
										<Gtk.ScrolledWindow class="device-scroll" hscrollbarPolicy={NEVER}>
											<box orientation={VERTICAL} vexpand hexpand>
												<For each={aps}>{ap => <Item ap={ap} />}</For>
											</box>
										</Gtk.ScrolledWindow>
									</revealer>
									<Gtk.Separator />
									<Settings callback={() => bash`XDG_CURRENT_DESKTOP=GNOME gnome-control-center wifi`} />
								</box>
							)
						}}
					</With>
				}
			/>
		)
	}
}

namespace Mirror {
	function getMonitors() {
		try {
			return (JSON.parse(exec("hyprctl monitors all -j")) as AstalHyprland.Monitor[]).filter(m => m.id !== 0)
		} catch (error) {
			console.error("Error fetching monitors:", error)
			return []
		}
	}

	function Item({ monitor, update }: { monitor: AstalHyprland.Monitor, update: () => void }) {
		// @ts-ignore: NOTE: A hacky way tracking mirroring in the existing type
		const mirrored = monitor.mirrorOf == "none"

		return (
			<button
				onClicked={() => {
					const command = `keyword monitor ${monitor.name}, highres, auto, 1${mirrored ? `, mirror, ${hypr?.get_monitor(0).name}` : ''}`
					hypr.message_async(command, null)
					update()
				}}
			>
				<box class="mirror-item horizontal">
					<image iconName={icons.ui.projector} pixelSize={16} />
					<label label={`${monitor.model} (${monitor.name}) ${mirrored ? "" : "(Mirrored)"}`} />
				</box>
			</button>
		)
	}

	const [monitors, set_monitors] = createState(getMonitors())

	export function Toggle() {
		return (
			<ArrowToggleButton
				name="mirror-selector"
				iconName={icons.ui.projector}
				label={"Mirror"}
				activate={() => set_opened("mirror-selector")}
				connection={opened.as(v => v == "mirror-selector")}
			/>
		)
	}

	export function Selector() {
		const ids = [
			hypr.connect("monitor-added", () => set_monitors(getMonitors())),
			hypr.connect("monitor-removed", () => set_monitors(getMonitors()))
		];

		onCleanup(() => {
			ids.forEach(id => hypr.disconnect(id));
		});
		const hasMonitors = monitors.as(ms => ms.length > 0)
		return (
			<Menu
				name={"mirror-selector"}
				iconName={icons.ui.projector}
				title={"Select display device"}
			>
				<box orientation={VERTICAL}>
					<revealer
						halign={CENTER}
						revealChild={hasMonitors.as(v => !v)}
						transitionDuration={options.transition.duration}
					>
						<Placeholder iconName={icons.missing} label={"No display devices found"} />
					</revealer>
					<revealer revealChild={hasMonitors} transitionDuration={options.transition.duration}>
						<Gtk.ScrolledWindow class="device-scroll" hscrollbarPolicy={NEVER}>
							<box orientation={VERTICAL} vexpand hexpand>
								<For each={monitors}>
									{(monitor) => (
										<Item
											monitor={monitor}
											update={() => { set_monitors(getMonitors()) }}
										/>
									)}
								</For>
							</box>
						</Gtk.ScrolledWindow>
					</revealer>
				</box>
			</Menu>
		)
	}
}

namespace Sliders {
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
		const speaker = audio?.default_speaker
		const hasAudioSpeaker = audio ? createBinding(audio, "nodes").as(n => n.some(item => item.get_media_class() === AUDIO_SOURCE)) : false
		const hasAudioStream = audio ? createBinding(audio, "nodes").as(n => n.some(item => item.get_media_class() === STREAM_OUTPUT_AUDIO)) : false

		return (
			<box>
				<ControlUnit device={speaker} />
				<box class="volume" valign={CENTER} visible={hasAudioSpeaker}>
					<Arrow name="device-selector" tooltipText={"Device Selector"} />
					<Arrow name="app-mixer" visible={hasAudioStream} tooltipText={"App Mixer"} />
				</box>
			</box>
		)
	}

	export function Microphone() {
		const hasDevices = createBinding(audio, "devices").as(a => a.length > 0)
		const mic = audio.get_default_microphone()
		return <ControlUnit device={mic} show={hasDevices} />
	}

	export function Brightness() {
		let prevBrightness = 1
		return (
			<box class="control-unit" visible={createBinding(brightness, "displayAvailable")}>
				<button
					valign={CENTER}
					onClicked={() => {
						if (brightness.display > 0) {
							prevBrightness = brightness.display
							brightness.display = 0
						} else {
							brightness.display = prevBrightness
						}
					}}
					tooltipText={createBinding(brightness, "display").as(v => `Screen Brightness: ${Math.floor(v * 100)}% `)}
				>
					<image iconName={createBinding(brightness, "iconName")} useFallback />
				</button>
				<slider
					drawValue={false}
					hexpand
					value={createBinding(brightness, "display")}
					onNotifyValue={({ value }) => {
						brightness.display = value
					}}
				/>
			</box>
		)
	}
}

function DarkModeToggle() {
	return (
		<SimpleToggleButton
			// @ts-ignore: Valid keys
			iconName={scheme.as((s: string) => icons.color[s])}
			label={scheme.as(s => s === "dark" ? "Dark" : "Light")}
			toggle={() => {
				const invert = scheme.get() === "dark" ? "light" : "dark"
				scheme.set(invert)
			}}
			connection={scheme.as(s => s === "dark")}
		/>
	)
}

function DNDToggle() {
	const dnd = createBinding(notifd, "dontDisturb")
	return (
		<SimpleToggleButton
			iconName={dnd.as(v => v ? icons.notifications.silent : icons.notifications.noisy)}
			label={dnd.as(v => v ? "Silent" : "Normal")}
			toggle={() => notifd.set_dont_disturb(!notifd.get_dont_disturb())}
			connection={dnd}
		/>
	)
}

function MediaPlayer({ player }: { player: AstalMpris.Player }) {
	const { PLAYING } = AstalMpris.PlaybackStatus
	const { PLAYLIST, TRACK, NONE } = AstalMpris.Loop
	const { ON, OFF } = AstalMpris.Shuffle

	const title = createBinding(player, "title").as(t => t || "Untitled")
	const artist = createBinding(player, "artist").as(a => a || "Unknown Artist")
	// TODO: Handle weird mpv format
	const cover = createBinding(player, "coverArt")
	const icon = createBinding(player, "entry").as(e => e && lookupIconName(e) ? e : "audio-x-generic-symbolic")
	const pos = createBinding(player, "position").as(p => player.length > 0 ? p / player.length : 0)
	const status = createBinding(player, "playbackStatus")
	const loop = createBinding(player, "loopStatus")
	const shuffle = createBinding(player, "shuffleStatus")
	const len = createBinding(player, "length")
	const control = createBinding(player, "canControl")
	const next = createBinding(player, "canGoNext")
	const prev = createBinding(player, "canGoPrevious")

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

	function cycleLoop(self: Gtk.Widget) {
		switch (player.loopStatus) {
			case NONE: player.set_loop_status(PLAYLIST); break
			case PLAYLIST: player.set_loop_status(TRACK); break
			case TRACK: player.set_loop_status(NONE); break
			default: toggleClass(self, "active", false); break
		}
	}

	function cycleShuffle(self: Gtk.Widget) {
		switch (player.shuffleStatus) {
			case OFF: player.set_shuffle_status(ON); toggleClass(self, "active", true); break
			case ON: player.set_shuffle_status(OFF); toggleClass(self, "active", false); break
			default: toggleClass(self, "active", false); break
		}
	}

	return (
		<box class="player" vexpand={false}>
			<Gtk.Picture
				class="cover-art"
				// @ts-ignore: Valid
				paintable={
					cover.as(url => {
						if (url) {
							const pixbuf = GdkPixbuf.Pixbuf.new_from_file(url).scale_simple(100, 100, BILINEAR)!
							return Gdk.Texture.new_for_pixbuf(pixbuf)
						}
					})
				}
				contentFit={SCALE_DOWN}
				canShrink
			/>

			<box orientation={VERTICAL}>
				<box class="title horizontal">
					<label wrap hexpand halign={START} label={title} maxWidthChars={20} />
					<image iconName={icon} useFallback />
				</box>
				<label class="artist" halign={START} valign={START} vexpand wrap label={artist} maxWidthChars={20} />
				<slider
					visible={len.as(l => l > 0)}
					onNotifyValue={({ value }) => player.position = value * player.length}
					value={pos}
				/>
				<box class="horizontal">
					<label
						hexpand
						class="position"
						halign={START}
						visible={len.as(l => l > 0)}
						label={pos.as(duration)}
					/>
					<box>
						<button
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
						label={len.as(l => l > 0 ? duration(l) : "0:00")}
					/>
				</box>
			</box>
		</box>
	)
}

export default function QuickSettings() {
	function Row({
		toggles = [],
		menus = [],
	}: {
		toggles?: Array<() => JSX.Element>
		menus?: Array<() => JSX.Element>
	} = {}) {
		return (
			<box orientation={VERTICAL}>
				<box class="row horizontal" homogeneous>
					{toggles.map(Toggle => Toggle())}
				</box>
				{menus.map(Menu => Menu())}
			</box>
		)
	}

	const Header = () =>
		<box class="header horizontal">
			<Gtk.Picture
				class="avatar"
				paintable={
					fileExists(env.paths.avatar)
					? Gdk.Texture.new_for_pixbuf(
						GdkPixbuf.Pixbuf.new_from_file(env.paths.avatar)
						.scale_simple(64, 64, GdkPixbuf.InterpType.BILINEAR)!
					)
					: null
				}
				contentFit={COVER}
				canShrink
			/>
			<box orientation={VERTICAL} valign={CENTER}>
				<box>
					<label class="username" label={env.username} />
				</box>
			</box>
			<box hexpand />
			<button
				valign={CENTER}
				onClicked={() => {
					const settings = app.get_window("settings-dialog")
					const qsettings = app.get_window("quicksettings")

					if (!settings?.visible) {
						settings?.show()
					} else {
						settings.hide()
						settings.show()
					}
					qsettings?.hide()
				}}
			>
				<image iconName={icons.ui.settings} useFallback />
			</button>
		</box >

	return (
		<PopupWindow
			name="quicksettings"
			exclusivity={Astal.Exclusivity.EXCLUSIVE}
			application={app}
			layout={layout}
		>
			<box class="quicksettings vertical"
				css={quicksettings.width.as((w: any) => `min-width: ${w}px;`)}
				orientation={VERTICAL}>
				<Header />
				<box class="sliders-box vertical" orientation={VERTICAL}>
					<Row
						toggles={[Sliders.Volume]}
						menus={[Audio.SinkSelector, Audio.AppMixer]}
					/>
					<Sliders.Microphone />
					<Sliders.Brightness />
				</box>
				<Row
					toggles={[Wifi.Toggle, Bluetooth.Toggle]}
					menus={[Wifi.Selector, Bluetooth.Selector]}
				/>
				<Row toggles={[DarkModeToggle, DNDToggle]} />
				<Row toggles={[Profiles.Toggle, Mirror.Toggle]} menus={[Profiles.Selector, Mirror.Selector]} />
				<box
					class="media vertical"
					visible={createBinding(media, "players").as(players => players.length > 0)}
					orientation={VERTICAL}
				>
					<For each={createBinding(media, "players")}>
						{(player: AstalMpris.Player) => <MediaPlayer player={player} />}
					</For>
				</box>
			</box>
		</PopupWindow>
	)
}
