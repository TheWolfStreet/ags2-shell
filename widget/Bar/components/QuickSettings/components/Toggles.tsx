import Hyprland from "gi://AstalHyprland?version=0.1"
import Audio from "gi://AstalWp"
import Network from "gi://AstalNetwork"
import Bluetooth from "gi://AstalBluetooth"
import { AstalIO, bind, exec, execAsync, timeout, Variable } from "astal"
import { Gdk, Gtk, Widget } from "astal/gtk3"

import { ScrolledWindow, Separator, Spinner } from "../../../../GtkWidgets"
import { Arrow, ArrowToggleButton, Menu, opened, SimpleToggleButton } from "./ToggleButton"

import { bt, net, notifd, pp, audio, asusctl, hypr } from "../../../../../lib/services"
import { bash, dependencies, launchApp } from "../../../../../lib/utils"
import icons from "../../../../../lib/icons"
import options from "../../../../../options"

const { CENTER, END } = Gtk.Align
const { AUDIO_SPEAKER, AUDIO_STREAM } = Audio.MediaClass
const { NEVER } = Gtk.PolicyType

const { scheme } = options.theme

const VolumeIndicator = ({ device }: { device: Audio.Endpoint | undefined }) =>
	<button valign={CENTER} onClick={() => device?.set_mute(!device?.get_mute())}>
		<icon
			icon={device && bind(device, "volumeIcon")}
			tooltipText={device && bind(device, "volume").as(v => `Volume: ${Math.floor((v ?? 0) * 100)}%`)}
			useFallback
		/>
	</button>

const VolumeSlider = ({ device }: { device: Audio.Endpoint | undefined }) =>
	<slider
		hexpand
		draw_value={false}
		onDragged={({ value, dragging }) => {
			if (dragging) {
				device?.set_volume(value)
				device?.set_mute(false)
			}
		}}
		value={device && bind(device, "volume")}
		className={device && bind(device, "mute").as(v => v ? "muted" : "")}
	/>

export function Volume() {
	const speaker = audio?.default_speaker

	const hasAudioSpeaker = (audio && bind(audio, "endpoints").as((a) =>
		a.filter((item) => item.get_media_class() === AUDIO_SPEAKER).length > 0)) ?? false

	const hasAudioStream = (audio && bind(audio, "endpoints").as((a) =>
		a.filter((item) => item.get_media_class() === AUDIO_STREAM).length > 0)) ?? false
	return (
		<box className="volume">
			<VolumeIndicator device={speaker} />
			<VolumeSlider device={speaker} />
			<box valign={CENTER} visible={hasAudioSpeaker}>
				<Arrow name="device-selector" tooltipText={"Device Selector"} />
			</box>
			<box visible={hasAudioStream}>
				<Arrow name="app-mixer" tooltipText={"App Mixer"} />
			</box>
		</box>
	)
}

export function Microphone() {
	const hasDevices = audio ? bind(audio, "devices").as((a) => a.length > 0) : false
	const mic = audio?.get_default_microphone() ?? undefined
	return (
		<box className="volume" visible={hasDevices}>
			<VolumeIndicator device={mic} />
			<VolumeSlider device={mic} />
		</box>
	)
}

const MixerItem = (endpoint: Audio.Endpoint) =>
	<box hexpand className="mixer-item horizontal">
		<icon
			icon={bind(endpoint, "icon")}
			tooltipText={bind(endpoint, "name").as((n) => n || "")}
			useFallback
		/>
		<box vertical>
			<label
				xalign={0}
				truncate
				maxWidthChars={28}
				label={bind(endpoint, "description").as((d) => d || "")}
			/>
			<slider
				hexpand
				drawValue={false}
				value={bind(endpoint, "volume")}
				onDragged={({ value }) => (endpoint.volume = value)}
			/>
		</box>
	</box>

const Settings = ({ callback: callback }: { callback: () => void }) =>
	<button onClick={callback} hexpand>
		<box className="settings">
			<icon icon={icons.ui.settings} useFallback />
			<label label={"Settings"} />
		</box>
	</button>

const SinkItem = (endpoint: Audio.Endpoint) =>
	<button hexpand onClick={() => (endpoint?.set_is_default(true))}>
		<box className="sink-item">
			<icon
				icon={bind(endpoint, "icon")}
				tooltipText={bind(endpoint, "name")}
				useFallback
			/>
			<label label={(endpoint.description || "").split(" ").slice(0, 4).join(" ")} />
			<icon
				icon={icons.ui.tick}
				hexpand
				halign={END}
				visible={(audio && bind(audio.defaultSpeaker, "description").as(s => s === endpoint.description)) ?? undefined}
				useFallback
			/>
		</box>
	</button>

export const AppMixer = () =>
	<Menu name="app-mixer" title="App Mixer" icon={icons.audio.mixer} child={
		<box vertical>
			<box vertical>
				{audio && bind(audio, "endpoints").as((a) => a.filter((item) => item.get_media_class() === AUDIO_STREAM).map(MixerItem))}
			</box>
			<Separator />
			<Settings callback={() => dependencies("pavucontrol") && execAsync("pavucontrol")} />
		</box>
	}
	/>

export const SinkSelector = () =>
	<Menu name="device-selector" title="Device Selector" icon={icons.audio.type.headset} child={
		<box vertical>
			<box vertical>
				{audio && bind(audio, "endpoints").as((a) => a.filter((item) => item.get_media_class() === AUDIO_SPEAKER).map(SinkItem))}
			</box>
			<Separator />
			<Settings callback={() => dependencies("pavucontrol") && execAsync("pavucontrol")} />
		</box>
	}
	/>

function AsusProfileToggle() {
	const asusprof = bind(asusctl, "profile")
	return (<ArrowToggleButton
		name="asusctl-profile"
		icon={asusprof.as(p => icons.asusctl.profile[p])}
		label={asusprof}
		connection={bind(asusctl, "profile").as(p => p != "Balanced")}
		activate={() => asusctl.profile = "Quiet"}
		deactivate={() => asusctl.profile = "Balanced"}
		activateOnArrow={false}
	/>)
}

function AsusProfileSelector() {
	const asusprof = bind(asusctl, "profile")
	return (<Menu
		name="asusctl-profile"
		icon={asusprof.as((p) => icons.asusctl.profile[p])}
		title="Profile Selector"
		child={
			<box vertical hexpand>
				<box vertical>
					<box vertical>
						{asusctl.profiles.map((prof) => (
							<button on_clicked={() => asusctl.profile = prof}>
								<box>
									<icon icon={icons.asusctl.profile[prof]} />
									<label label={prof} />
								</box>
							</button>
						))}
					</box>
				</box>
				<Separator />
				<Settings callback={() => launchApp("rog-control-center")} />
			</box>
		}
	/>)
}

function pretty(str: string) {
	return str
		.split("-")
		.map((str) => `${str.at(0)?.toUpperCase()}${str.slice(1)}`)
		.join(" ")
}

function PowerProfileToggle() {
	const profile = bind(pp, "activeProfile")
	const profiles = pp.get_profiles().map((p) => p.profile)
	return (<ArrowToggleButton
		name="asusctl-profile"
		icon={profile.as(p => icons.powerprofile[p as keyof typeof icons.powerprofile])}
		label={profile.as(pretty)}
		connection={profile.as(p => p !== profiles[1])}
		activate={() => (pp.set_active_profile(profiles[0]))}
		deactivate={() => (pp.set_active_profile(profiles[1]))}
		activateOnArrow={false}
	/>)
}

function PowerProfileSelector() {
	const profile = bind(pp, "activeProfile")
	const profiles = pp.get_profiles().map((p) => p.profile)
	return (
		<Menu
			name="asusctl-profile"
			// @ts-ignore: Valid keys
			icon={icons.powerprofile[profile]}
			title="Profile Selector"
			child={<box>
				<box vertical hexpand>
					<box vertical>
						{profiles.map(p => (
							<button on_clicked={() => pp.set_active_profile(p)}>
								<box>
									{/* @ts-ignore: Valid keys*/}
									<icon icon={icons.powerprofile[p]} />
									<label label={pretty(p)} />
								</box>
							</button>
						))}
					</box>
				</box>
			</box>
			}
		/>)
}

export function BtToggle() {
	const powered = bind(bt, "isPowered")
	const connected = bind(bt, "isConnected")

	const label = Variable.derive([powered, connected], (p, c) => {
		if (!p) return "Disabled"
		if (c) return bt.devices.filter(d => d.connected).at(0)?.name
		return "Not Connected"
	})

	return (
		<ArrowToggleButton
			activate={() => !powered.get() && bt.toggle()}
			deactivate={() => bt.toggle()}
			name="bluetooth"
			icon={powered.as(p => p ? icons.bluetooth.enabled : icons.bluetooth.disabled)}
			label={label()}
			connection={powered}
		/>
	)
}

function BtDevice(device: Bluetooth.Device) {
	// TODO: Add battery levels when the library will update to include it
	const connecting = bind(device, "connecting")
	const percentage = bind(device, "battery_percentage")
	const { BUTTON_PRIMARY, BUTTON_SECONDARY } = Gdk
	return (
		<button
			onClick={(self, event) => {
				switch (event.button) {
					case BUTTON_PRIMARY:
						device[device.connected ? 'disconnect_device' : 'connect_device'](() => self.toggleClassName("active", !device.connected))
						break
					case BUTTON_SECONDARY:
						device.paired && bash`bluetoothctl remove ${device.get_address()}`
						break
				}
			}}>

			<box>
				<icon icon={bind(device, "icon").as(i => i + "-symbolic")} />
				<label label={bind(device, "name")} />
				<label visible={percentage.as(v => v != undefined)} label={percentage.as(v => `${v * 100}%`)} />
				<box hexpand />
				<Spinner active={connecting} visible={connecting} />
			</box>
		</button>
	)
}

export function BtSelector() {
	let stop: AstalIO.Time | undefined
	return Variable.derive([bind(bt, "adapter")], (adapter) => {
		if (!adapter) return <box visible={false} />

		const discovering = bind(adapter, "discovering")
		const devices = bind(bt, "devices").as(ds => ds.filter(d => d.name))
		const hasDevices = devices.as(ds => ds.length > 0)

		const Header = () =>
			adapter && <box>
				<box hexpand />
				<button
					halign={END}
					onClick={() => {
						stop?.cancel()
						if (!adapter.powered) {
							adapter.set_powered(true)
						}
						adapter[adapter.discovering ? 'stop_discovery' : 'start_discovery']()
						stop = (timeout(10000, () => adapter.stop_discovery()))
					}}
				>
					<box>
						<label label={discovering.as(d => d ? "Stop searching" : "Search devices")} />
					</box>
				</button>
			</box>

		const Placeholder = () =>
			<revealer
				halign={CENTER}
				className="placeholder vertical"
				revealChild={hasDevices.as(v => !v)}
			>
				<box vertical>
					<icon icon={icons.bluetooth.disabled} useFallback />
					<label visible={adapter != undefined} label={discovering.as(d => d ? "Searching for devices..." : "No devices found")} />
				</box>
			</revealer>

		return (
			<Menu
				name={"bluetooth"}
				icon={icons.bluetooth.disabled}
				title={"Bluetooth"}
				headerChild={<Header />}
				child={
					<box vertical>
						<Placeholder />
						<revealer revealChild={hasDevices}>
							<ScrolledWindow className="device-scroll" visible={hasDevices}>
								<box vexpand vertical>
									{devices.as(ds => ds.map(BtDevice))}
								</box>
							</ScrolledWindow>
						</revealer>
					</box>
				}
			/>
		)
	})()
}

export function WifiToggle() {
	const wifi = net.wifi
	// TODO: Check wifi adapter dynamically
	const enabled = wifi ? bind(wifi, "enabled") : Variable(false)()
	return (
		<ArrowToggleButton
			name="network"
			icon={wifi ? bind(wifi, "iconName") : icons.wifi.offline}
			label={wifi ? bind(wifi, "ssid").as(s => s || "Not Connected") : "No Adapter"}
			connection={enabled}
			activate={() => {
				if (!wifi) return
				wifi.set_enabled(true)
				!wifi.scanning && wifi.scan()
			}}
			deactivate={() => {
				if (!wifi) return
				wifi.set_enabled(false)
			}}
		/>
	)
}

const WifiNetwork = ({ ap }: { ap: Network.AccessPoint }) =>
	<button onClick={() => dependencies("nmcli") && execAsync(`nmcli device wifi connect ${ap.bssid}`)}>
		<box>
			<icon icon={bind(ap, "iconName")} />
			<label label={bind(ap, "ssid").as(v => v || "Hidden network")} />
			<icon
				icon={icons.ui.tick}
				hexpand
				halign={END}
				visible={bind(net.wifi, "activeAccessPoint").as(v => v?.bssid === ap.bssid)}
			/>
		</box>
	</button>

export function WifiSelector() {
	const wifi = net.wifi
	if (!wifi) return <box visible={false} />

	const aps = bind(wifi, "accessPoints").as(aps => aps.filter(ap => ap.ssid).sort((a, b) => b.strength - a.strength))
	const hasAps = aps.as(aps => aps.length > 0)

	const Placeholder = () =>
		<revealer
			halign={CENTER}
			className="placeholder vertical"
			revealChild={hasAps.as(v => !v)}
		>
			<box vertical>
				<icon icon={icons.wifi.scanning} />
				<label label={"Searching for wifi networks..."} />
			</box>
		</revealer>

	return (
		<Menu
			name={"network"}
			icon={bind(wifi, "iconName")}
			title={"Visible networks"}
			child={
				<box vertical>
					<Placeholder />
					<revealer revealChild={hasAps}>
						<ScrolledWindow className="device-scroll" hscrollbarPolicy={NEVER}>
							<box vertical vexpand hexpand>
								{aps.as(aps => aps.map(ap => <WifiNetwork ap={ap} />))}
							</box>
						</ScrolledWindow>
					</revealer>
					<Separator />
					<Settings callback={() => bash`XDG_CURRENT_DESKTOP=GNOME gnome-control-center wifi`} />
				</box>
			}
		/>
	)
}

export const DarkModeToggle = () =>
	<SimpleToggleButton
		icon={scheme(s => icons.color[s])}
		label={scheme(s => s === "dark" ? "Dark" : "Light")}
		toggle={() => {
			const invert = scheme.get() === "dark" ? "light" : "dark"
			scheme.set(invert)
		}}
		connection={scheme(s => s === "dark")}
	/>

export function DNDToggle() {
	const dnd = bind(notifd, "dontDisturb")
	return (
		<SimpleToggleButton
			icon={dnd.as(v => v ? icons.notifications.silent : icons.notifications.noisy)}
			label={dnd.as(v => v ? "Silent" : "Normal")}
			toggle={() => notifd.set_dont_disturb(!notifd.get_dont_disturb())}
			connection={dnd}
		/>
	)
}

export const ProfileToggle = asusctl.available
	? AsusProfileToggle
	: PowerProfileToggle

export const ProfileSelector = asusctl.available
	? AsusProfileSelector
	: PowerProfileSelector

export const ProjectToggle = () =>
	<ArrowToggleButton
		name="mirror"
		icon={icons.ui.projector}
		label={"Mirror"}
		activate={() => opened.set("mirror")}
		activateOnArrow={false}
		connection={opened().as(v => v == "mirror")}
	/>

function DisplayDevice({ monitor, update }: { monitor: Hyprland.Monitor, update: () => void }) {
	// @ts-ignore: A hacky way of utilizing the existing type
	const mirrored = monitor.mirrorOf == "none"
	return (
		<button
			onClick={() => {
				const command = `keyword monitor ${monitor.name}, highres, auto, 1${mirrored ? `, mirror, ${hypr?.get_monitor(0).name}` : ''}`
				hypr.message_async(command, null)
				update()
			}}>
			<box>
				<icon icon={icons.ui.projector} />
				<label label={`${monitor.model} (${monitor.name}) ${mirrored ? "" : "(Mirrored)"}`} />
			</box>
		</button>
	)
}

export function ProjectSelector() {
	function getMonitors() {
		try {
			return (JSON.parse(exec("hyprctl monitors all -j")) as Hyprland.Monitor[]).filter(m => m.id !== 0)
		} catch (error) {
			console.error("Error fetching monitors:", error)
			return []
		}
	}

	async function update() {
		monitors.set(getMonitors())
		devices.get_children().forEach(c => c.destroy())
		devices.set_children(monitors.get().map(m => <DisplayDevice monitor={m} update={update} />))
	}

	const monitors = Variable(getMonitors())
	const devices = (
		<box vertical vexpand hexpand>
			{monitors.get().map(m => <DisplayDevice monitor={m} update={update} />)}
		</box>
	) as Widget.Box

	["monitor-added", "monitor-removed"].forEach(event => hypr.connect(event, update))
	const hasMonitors = monitors().as(ms => ms.length > 0)
	const Placeholder = () =>
		<revealer
			halign={CENTER}
			className="placeholder vertical"
			revealChild={hasMonitors.as(v => !v)}
		>
			<box vertical>
				<icon icon={icons.missing} useFallback />
				<label label={"No display devices found"} />
			</box>
		</revealer>

	return (
		<Menu
			name={"mirror"}
			icon={icons.ui.projector}
			title={"Select display device"}
			child={
				<box vertical>
					<Placeholder />
					<revealer revealChild={hasMonitors}>
						<ScrolledWindow className="device-scroll" hscrollbarPolicy={NEVER}>
							{devices}
						</ScrolledWindow>
					</revealer>
				</box>
			}
		/>
	)
}
