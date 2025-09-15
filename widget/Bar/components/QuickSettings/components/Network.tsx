import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { timeout } from "ags/time"
import { createBinding, With, For, createComputed } from "gnim"

import AstalNetwork from "gi://AstalNetwork?version=0.1"

import { Placeholder } from "widget/shared/Placeholder"
import { ArrowToggleButton, Menu, Settings } from "./shared/MenuElements"

import icons from "$lib/icons"
import { net } from "$lib/services"
import { dependencies, bash } from "$lib/utils"

import options from "options"

const { CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { NEVER } = Gtk.PolicyType

export namespace Network {
	export namespace Wifi {
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
	}

	export function State() {
		const { WIRED, WIFI } = AstalNetwork.Primary
		const adapter = createComputed([createBinding(net, "primary"), createBinding(net, "wifi"), createBinding(net, "wired")], (type, wifi, wired) => {
			switch (type) {
				case (WIFI):
					return wifi

				case (WIRED):
					return wired

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
