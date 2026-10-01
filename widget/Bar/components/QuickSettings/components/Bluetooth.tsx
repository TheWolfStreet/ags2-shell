import { Gtk, Gdk } from "ags/gtk4"
import { createBinding, createComputed, With, For, onCleanup } from "ags"
import { execAsync } from "ags/process"

import AstalBluetooth from "gi://AstalBluetooth"

import {
	ToggleButton,
	Menu,
	SettingsButton,
	quick_settings_submenu,
} from "widget/Bar/components/QuickSettings/components/MenuControls"
import { Placeholder } from "widget/shared/Placeholder"

import icons from "$lib/icons"
import { notify_missing_programs } from "$lib/notifications"
import { attempt, attempt_async, log_error } from "$lib/result"
import { on_window_toggle } from "$lib/windowing"

import options from "$shell/options"

const bluetooth = AstalBluetooth.get_default()

export namespace Bluetooth {
	export function Toggle() {
		const powered = createBinding(bluetooth, "isPowered")
		const connected = createBinding(bluetooth, "isConnected")
		const adapters = createBinding(bluetooth, "adapters")

		const label = createComputed(() => {
			if (adapters().length == 0) return "No Device"
			if (!powered()) return "Disabled"
			if (connected())
				return bluetooth.devices.filter((d) => d.connected).at(0)?.name ?? ""
			return "Not Connected"
		})

		return (
			<ToggleButton
				arrow
				name="bluetooth-selector"
				label={label}
				iconName={powered.as((p) =>
					p ? icons.bluetooth.enabled : icons.bluetooth.disabled,
				)}
				onArrow={() => {
					if (!powered.peek()) set_bluetooth_powered(true)
				}}
				onToggle={() => set_bluetooth_powered(!powered.peek())}
				connection={powered}
			/>
		)
	}

	export function Selector() {
		const adapter = createBinding(bluetooth, "adapter")
		let owned_discovery: AstalBluetooth.Adapter | null = null
		const stop_owned_discovery = () => {
			const owned = owned_discovery
			owned_discovery = null
			if (owned)
				log_error(attempt(() => owned.stop_discovery()), "bluetooth.discovery: Failed to stop scan")
		}
		const unsubscribe_opened = quick_settings_submenu.opened.subscribe(() => {
			if (quick_settings_submenu.opened.peek() !== "bluetooth-selector") stop_owned_discovery()
		})
		const unsubscribe_window = on_window_toggle("quicksettings", (window) => {
			if (!window.visible) stop_owned_discovery()
		})
		onCleanup(() => { unsubscribe_opened(); unsubscribe_window(); stop_owned_discovery() })
		const devices = createBinding(bluetooth, "devices").as((d) =>
			(d ?? []).slice().sort((a, b) => {
				const a_name = a.name && a.name.trim() !== ""
				const b_name = b.name && b.name.trim() !== ""
				return (b_name ? 1 : 0) - (a_name ? 1 : 0)
			}),
		)

		return (
			<Menu
				name="bluetooth-selector"
				iconName={icons.bluetooth.disabled}
				title="Bluetooth devices"
				headerChild={
					<With value={adapter}>
						{(adapter) => {
							if (!adapter) return <box visible={false} />

							const discovering = createBinding(adapter, "discovering")

							const on_toggle_discover = () => {
								if (owned_discovery && owned_discovery !== adapter) stop_owned_discovery()
								const result = attempt(() => {
									if (discovering.peek()) {
										adapter.stop_discovery()
										if (owned_discovery === adapter) owned_discovery = null
									} else {
										if (!adapter.powered) adapter.set_powered(true)
										adapter.start_discovery()
										owned_discovery = adapter
									}
								})
								log_error(result, "bluetooth.discovery: Failed to change scan state")
							}

							return (
								<centerbox hexpand>
									<button $type="end" onClicked={on_toggle_discover}>
										<label
											label={discovering.as((d) => (d ? "Cancel" : "Scan"))}
										/>
									</button>
								</centerbox>
							)
						}}
					</With>
				}
			>
				<With value={adapter}>
					{(adapter) => {
						if (!adapter)
							return (
								<Placeholder
									iconName={icons.bluetooth.disabled}
									label="No Device Found"
								/>
							)

						const discovering = createBinding(adapter, "discovering")
						const has_devices = devices.as((d) => d.length > 0)

						return (
							<box orientation={VERTICAL}>
								<revealer
									halign={CENTER}
									revealChild={has_devices.as((v) => !v)}
									transitionDuration={options.transition.duration}
								>
									<Placeholder
										iconName={icons.bluetooth.disabled}
										label={discovering.as((d) =>
											d ? "Searching for devices..." : "No devices found",
										)}
									/>
								</revealer>
								<revealer
									revealChild={has_devices}
									transitionDuration={options.transition.duration}
								>
									<Gtk.ScrolledWindow class="device-scroll" vexpand>
										<box orientation={VERTICAL} vexpand hexpand>
											<For each={devices}>
												{(dev: AstalBluetooth.Device) => <Entry device={dev} />}
											</For>
										</box>
									</Gtk.ScrolledWindow>
								</revealer>
								<Gtk.Separator />
								<SettingsButton
									callback={() =>
										void attempt_async(() => execAsync([
											"env",
											"XDG_CURRENT_DESKTOP=GNOME",
											"gnome-control-center",
											"bluetooth",
										])).then((result) => log_error(result, "bluetooth.settings: Failed to open settings"))
									}
								/>
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
				class={createBinding(bluetooth, "isConnected").as((v) =>
					v ? "bluetooth-connected" : "",
				)}
				visible={createBinding(bluetooth, "isPowered")}
				iconName={icons.bluetooth.enabled}
				useFallback
			/>
		)
	}

	const { VERTICAL } = Gtk.Orientation
	const { CENTER } = Gtk.Align
	const { BUTTON_PRIMARY, BUTTON_SECONDARY } = Gdk

	function Entry({ device }: { device: AstalBluetooth.Device }) {
		const connecting = createBinding(device, "connecting")
		const connected = createBinding(device, "connected")
		const name = createBinding(device, "name")
		const address = createBinding(device, "address")
		const battery = createBinding(device, "batteryPercentage")
		const paired = createBinding(device, "paired")
		const label = createComputed(
			() => `${name() || address()}${paired() ? " • Paired" : ""}`,
		)
		const battery_label = createComputed(() =>
			paired() && battery() != undefined && battery() >= 0
				? `${Math.round(battery() * 100)}%`
				: "",
		)

		return (
			<button
				class={connected.as((value) => value ? "active" : "")}
				tooltipText={createBinding(device, "paired").as((p) =>
					p ? "Right-click to unpair" : "",
				)}
			>
				<Gtk.GestureClick
					button={0}
					onPressed={(self) => {
						const m_btn = self.get_current_button()
						switch (m_btn) {
							case BUTTON_PRIMARY: {
								if (device.get_connected()) {
									log_error(attempt(() => device.disconnect_device((source_device, result) => {
										log_error(attempt(() => device.disconnect_device_finish(result)), "bluetooth.device: Failed to disconnect")
									})), "bluetooth.device: Failed to start disconnect")
								} else {
									log_error(attempt(() => device.connect_device((source_device, result) => {
										log_error(attempt(() => device.connect_device_finish(result)), "bluetooth.device: Failed to connect")
									})), "bluetooth.device: Failed to start connection")
								}
								break
							}
							case BUTTON_SECONDARY:
								if (device.paired && notify_missing_programs("bluetoothctl")) {
									void attempt_async(() => execAsync([
										"bluetoothctl",
										"remove",
										device.get_address(),
									])).then((result) => log_error(result, "bluetooth.device: Failed to unpair"))
								}
								break
						}
						self.reset()
					}}
				/>

				<box class="bluetooth-item horizontal">
					<image
						iconName={createBinding(device, "icon").as((v) => v + "-symbolic")}
					/>
					<label label={label} />
					<box hexpand />
					<label
						class="device-detail"
						label={battery_label}
						visible={battery_label.as((value) => value.length > 0)}
					/>
					<Gtk.Spinner spinning={connecting} visible={connecting} />
				</box>
			</button>
		)
	}

	function set_bluetooth_powered(on: boolean) {
		const adapter = bluetooth.get_adapter()
		if (!adapter) return
		log_error(attempt(() => adapter.set_powered(on)), "bluetooth.power: Failed to change power")
	}
}
