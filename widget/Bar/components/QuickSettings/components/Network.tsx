import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import { timeout } from "ags/time"
import { createBinding, With, For, createComputed, createState } from "ags"

import AstalNetwork from "gi://AstalNetwork"

import { Placeholder } from "widget/shared/Placeholder"
import { ArrowToggleButton, Menu, Settings } from "./shared/MenuElements"

import icons from "$lib/icons"
import { net } from "$lib/services"
import { bash } from "$lib/utils"

import options from "options"

const { CENTER, END, START } = Gtk.Align
const { VERTICAL, HORIZONTAL } = Gtk.Orientation
const { NEVER } = Gtk.PolicyType

const [currentAp, setCurrentAp] = createState<AstalNetwork.AccessPoint | null>(null)
const [password, setPassword] = createState("")
const [passwordVisible, setPasswordVisible] = createState(false)
const [isConnecting, setIsConnecting] = createState(false)

let stateChangedId: number | null = null

export namespace Network {
	export namespace Wifi {
		function Item({ ap }: { ap: AstalNetwork.AccessPoint }) {
			const handleClick = () => {
				setCurrentAp(ap)
				setPassword("")
				setPasswordVisible(false)

				if (stateChangedId !== null && net.wifi) {
					net.wifi.disconnect(stateChangedId)
					stateChangedId = null
				}

				if (net.wifi) {
					stateChangedId = net.wifi.connect("state-changed", (_wifi: any, _oldState: any, newState: AstalNetwork.DeviceState) => {
						if (newState === AstalNetwork.DeviceState.FAILED) {
							const win = app.get_window("wifi-auth")
							win?.show()
							if (stateChangedId !== null && net.wifi) {
								net.wifi.disconnect(stateChangedId)
								stateChangedId = null
							}
						}
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
							visible={createBinding(net.wifi, "activeAccessPoint").as(v => v?.bssid === ap.bssid)}
						/>
					</box>
				</button>
			)

		}

		export function Toggle() {
			// TODO: Monitor mode tracking
			const wifi = createBinding(net, "wifi")
			return (
				<With value={wifi}>
					{w => {
						if (!w) return <ArrowToggleButton name="wifi-selector" iconName={icons.wifi.offline} label={"No device"} />
						return (
							<ArrowToggleButton
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

		export function Window() {
			const handleConnect = async () => {
				if (!currentAp) return

				setIsConnecting(true)

				if (stateChangedId !== null && net.wifi) {
					net.wifi.disconnect(stateChangedId)
					stateChangedId = null
				}

				try {
					currentAp.peek()?.activate(password.peek() || null, null)
					const win = app.get_window("wifi-auth")
					win?.hide()
					setPassword("")
					setCurrentAp(null)
				} catch (error) {
					console.error("Failed to connect to WiFi:", error)
				} finally {
					setIsConnecting(false)
				}
			}

			const handleCancel = () => {
				if (stateChangedId !== null && net.wifi) {
					net.wifi.disconnect(stateChangedId)
					stateChangedId = null
				}

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
		const primary = createBinding(net, "primary")
		const wifi = createBinding(net, "wifi")
		const wired = createBinding(net, "wired")
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
