// Lists Wi-Fi and wired devices and shows connection and password controls.

import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import { timeout } from "ags/time"
import { createBinding, With, For, createComputed, createState } from "ags"
import { execAsync } from "ags/process"

import AstalNetwork from "gi://AstalNetwork"

import { Placeholder } from "widget/Placeholder"
import { ToggleButton, Menu, SettingsButton } from "./MenuControls"

import icons from "$lib/icons"
import { attempt } from "$lib/result"
import { network } from "$service/astal"

import options from "options"

const { CENTER, END, START } = Gtk.Align
const { VERTICAL, HORIZONTAL } = Gtk.Orientation
const { NEVER } = Gtk.PolicyType

const [currentAp, setCurrentAp] = createState<AstalNetwork.AccessPoint | null>(null)
const [password, setPassword] = createState("")
const [passwordVisible, setPasswordVisible] = createState(false)
const [isConnecting, setIsConnecting] = createState(false)

let stateChangedId: number | null = null
let watchedWifi: AstalNetwork.Wifi | null = null

function disconnectActivationWatcher() {
	if (stateChangedId !== null && watchedWifi)
		watchedWifi.disconnect(stateChangedId)
	stateChangedId = null
	watchedWifi = null
}

app.connect("shutdown", disconnectActivationWatcher)

export namespace Network {
	export namespace Wifi {
		function Item({ ap }: { ap: AstalNetwork.AccessPoint }) {
			const handleClick = () => {
				setCurrentAp(ap)
				setPassword("")
				setPasswordVisible(false)

				disconnectActivationWatcher()

				if (network.wifi) {
					watchedWifi = network.wifi
					stateChangedId = watchedWifi.connect("state-changed", (_wifi, _oldState, newState: AstalNetwork.DeviceState) => {
						if (newState === AstalNetwork.DeviceState.FAILED) {
							const win = app.get_window("wifi-auth")
							win?.show()
						}
						if (newState === AstalNetwork.DeviceState.FAILED || newState === AstalNetwork.DeviceState.ACTIVATED)
							disconnectActivationWatcher()
					})
				}

				ap.activate(null, null)
			}

			return (
				<button onClicked={handleClick}>
					<box class="wifi-item horizontal">
						<image iconName={createBinding(ap, "iconName")} />
						<label label={createBinding(ap, "ssid").as(v => v || "Hidden network")} />
						<image
							iconName={icons.ui.tick}
							hexpand
							halign={END}
							visible={createBinding(network.wifi, "activeAccessPoint").as(v => v?.bssid === ap.bssid)}
						/>
					</box>
				</button>
			)

		}

		export function Toggle() {
			const wifi = createBinding(network, "wifi")
			return (
				<With value={wifi}>
					{w => {
						if (!w) return <ToggleButton arrow name="wifi-selector" iconName={icons.wifi.offline} label={"No device"} />
						return (
							<ToggleButton
								arrow
								name="wifi-selector"
								iconName={createBinding(w, "iconName")}
								label={
									createBinding(w, "activeAccessPoint")
										.as(ap => ap?.ssid || "Not Connected")
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
			const wifi = createBinding(network, "wifi")

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
									.as(aps => {
										const best = new Map()

										for (const ap of aps) {
											if (!ap.ssid) continue

											const prev = best.get(ap.ssid)
											if (!prev || ap.strength > prev.strength) {
												best.set(ap.ssid, ap)
											}
										}

										return Array.from(best.values())
											.sort((a, b) => b.strength - a.strength)
									})

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
										<SettingsButton callback={() => void execAsync(["env", "XDG_CURRENT_DESKTOP=GNOME", "gnome-control-center", "wifi"])} />
									</box>
								)
							}}
						</With>
					}
				/>
			)
		}

		export function Window() {
			const handleConnect = async () => {
				if (!currentAp.peek()) return

				setIsConnecting(true)

				disconnectActivationWatcher()

				const result = attempt(() => {
					currentAp.peek()?.activate(password.peek() || null, null)
					const win = app.get_window("wifi-auth")
					win?.hide()
					setPassword("")
					setCurrentAp(null)
				})
				if (!result.ok)
					console.error("Failed to connect to WiFi:", result.err)
				setIsConnecting(false)
			}

			const handleCancel = () => {
				disconnectActivationWatcher()

				const win = app.get_window("wifi-auth")
				win?.hide()
				setPassword("")
				setCurrentAp(null)
				setIsConnecting(false)
			}

			return (
				<Gtk.Window
					title="WIFI Authentication"
					name="wifi-auth"
					application={app}
					hideOnClose
					iconName={icons.wifi.enabled}
				>
					<box class="vertical" orientation={VERTICAL}>
						<box class="header horizontal" orientation={HORIZONTAL}>
							<button
								onClicked={handleCancel}
								sensitive={isConnecting.as(v => !v)}
							>
								<label label="Cancel" />
							</button>
							<label
								label={currentAp.as(ap => `${ap?.ssid}`)}
								hexpand
								halign={CENTER}
							/>
							<button
								onClicked={handleConnect}
								sensitive={isConnecting.as(v => !v)}
							>
								<label label={isConnecting.as(v => v ? "Connecting..." : "Connect")} />
							</button>
						</box>

						<box class="entry-row" vexpand valign={START} orientation={HORIZONTAL}>
							<entry
								placeholderText="Enter password"
								visibility={passwordVisible}
								hexpand
								text={password}
								onNotifyText={self => setPassword(self.text)}
								onActivate={handleConnect}
								sensitive={isConnecting.as(v => !v)}
							/>
							<button
								onClicked={() => setPasswordVisible(!passwordVisible())}
								tooltipText={passwordVisible.as(v => v ? "Hide password" : "Show password")}
							>
								<image iconName={passwordVisible.as(v => v ? icons.ui.hidden : icons.ui.eye)} />
							</button>
						</box>
					</box>
				</Gtk.Window >
			)
		}
	}

	export function State() {
		const { WIRED, WIFI } = AstalNetwork.Primary
		const primary = createBinding(network, "primary")
		const wifi = createBinding(network, "wifi")
		const wired = createBinding(network, "wired")
		const adapter = createComputed(() => {
			switch (primary()) {
				case (WIFI):
					return wifi()

				case (WIRED):
					return wired()

				default:
					return undefined
			}
		})

		return (
			<box visible={adapter.as(v => v !== undefined)}>
				<With value={adapter}>
					{(adapter) =>
						adapter &&
						<image
							iconName={createBinding(adapter, "iconName")}
							useFallback
						/>
					}
				</With>
			</box>
		)
	}
}
