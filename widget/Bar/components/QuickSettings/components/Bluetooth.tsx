import { Gtk, Gdk } from "ags/gtk4"
import { createBinding, createComputed, With, For } from "ags"

import AstalBluetooth from "gi://AstalBluetooth"

import { ArrowToggleButton, Menu, Settings } from "widget/Bar/components/QuickSettings/components/shared/MenuElements"
import { Placeholder } from "widget/shared/Placeholder"

import icons from "$lib/icons"
import { bt } from "$lib/services"
import { toggleClass, bash } from "$lib/utils"

import options from "options"

const { VERTICAL } = Gtk.Orientation
const { CENTER } = Gtk.Align

export namespace Bluetooth {
	function Entry({ device }: { device: AstalBluetooth.Device }) {
		const connecting = createBinding(device, "connecting")
		const name = createBinding(device, "name")
		const address = createBinding(device, "address")
		const battery = createBinding(device, "batteryPercentage")
		const paired = createBinding(device, "paired")
		const label = createComputed(() => {
			const displayName = name() ?? address()
			const bat = paired() && battery() != undefined
				? ` ${(battery() * 100)}%`.replace(/-/g, "")
				: ""
			const isPaired = paired() ? " • Paired" : ""
			return `${displayName}${bat}${isPaired}`
		})

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

		const label = createComputed(() => {
			if (adapters().length == 0) return "No Device"
			if (!powered()) return "Disabled"
			if (connected()) return bt.devices.filter(d => d.connected).at(0)?.name ?? ""
			return "Not Connected"
		})

		return (
			<ArrowToggleButton
				name="bluetooth-selector"
				label={label}
				iconName={powered.as(p => p ? icons.bluetooth.enabled : icons.bluetooth.disabled)}
				activateOnArrow={true}
				activate={() => !powered.peek() && bt.toggle()}
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
								if (discovering.peek()) adapter.stop_discovery()
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
												{(dev: AstalBluetooth.Device) => <Entry device={dev} />}
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

	export function State() {
		return (
			<image
				class={createBinding(bt, "isConnected").as(v => v ? "bluetooth-connected" : "")}
				visible={createBinding(bt, "isPowered")}
				iconName={icons.bluetooth.enabled}
				useFallback
			/>
		)
	}
}
