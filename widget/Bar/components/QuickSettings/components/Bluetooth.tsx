import { Gtk, Gdk } from "ags/gtk4"
import { createBinding, createComputed, With, For, onCleanup } from "ags"
import { execAsync } from "ags/process"

import AstalBluetooth from "gi://AstalBluetooth"

import {
	ToggleButton,
	Menu,
	SettingsButton,
	open_gnome_settings,
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
	const menu_name = "bluetooth-selector"

	export function Toggle() {
		const powered = createBinding(bluetooth, "isPowered")
		const connected = createBinding(bluetooth, "isConnected")
		const adapters = createBinding(bluetooth, "adapters")
		const devices = createBinding(bluetooth, "devices")

		const label = createComputed(() => {
			if (adapters().length === 0) return "No Device"
			if (!powered()) return "Disabled"
			if (connected())
				return (
					devices().find((device) => createBinding(device, "connected")())
						?.name ?? ""
				)
			return "Not Connected"
		})

		return (
			<ToggleButton
				arrow
				name={menu_name}
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
				log_error(
					attempt(() => owned.stop_discovery()),
					"bluetooth.discovery: Failed to stop scan",
				)
		}
		const unsubscribe_opened = quick_settings_submenu.opened.subscribe(() => {
			if (quick_settings_submenu.opened.peek() !== menu_name)
				stop_owned_discovery()
		})
		const unsubscribe_window = on_window_toggle("quicksettings", (window) => {
			if (!window.visible) stop_owned_discovery()
		})
		onCleanup(() => {
			unsubscribe_opened()
			unsubscribe_window()
			stop_owned_discovery()
		})
		const toggle_discovery = (adapter: AstalBluetooth.Adapter) => {
			if (owned_discovery && owned_discovery !== adapter) stop_owned_discovery()
			const changed = attempt(() => {
				if (adapter.discovering) {
					adapter.stop_discovery()
					if (owned_discovery === adapter) owned_discovery = null
					return
				}
				if (!adapter.powered) adapter.set_powered(true)
				adapter.start_discovery()
				owned_discovery = adapter
			})
			log_error(changed, "bluetooth.discovery: Failed to change scan state")
		}
		const devices = createBinding(bluetooth, "devices").as((list) =>
			(list ?? [])
				.slice()
				.sort((a, b) => Number(has_name(b)) - Number(has_name(a))),
		)

		return (
			<Menu
				name={menu_name}
				iconName={icons.bluetooth.disabled}
				title="Bluetooth devices"
				header_child={
					<With value={adapter}>
						{(adapter) => {
							if (!adapter) return <box visible={false} />

							const discovering = createBinding(adapter, "discovering")
							return (
								<centerbox hexpand>
									<button
										$type="end"
										onClicked={() => toggle_discovery(adapter)}
									>
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
									callback={() => open_gnome_settings("bluetooth")}
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
		const battery_label = createComputed(() => {
			if (!paired()) return ""
			const level = battery()
			if (level == undefined || level < 0) return ""
			return `${Math.round(level * 100)}%`
		})

		return (
			<button
				class={connected.as((value) => (value ? "active" : ""))}
				tooltipText={paired.as((value) =>
					value ? "Right-click to unpair" : "",
				)}
			>
				<Gtk.GestureClick
					button={0}
					onPressed={(self) => {
						const button = self.get_current_button()
						if (button === BUTTON_PRIMARY) toggle_connection(device)
						if (button === BUTTON_SECONDARY) unpair(device)
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

	function has_name(device: AstalBluetooth.Device) {
		return Boolean(device.name) && device.name.trim() !== ""
	}

	function connect(device: AstalBluetooth.Device) {
		const started = attempt(() =>
			device.connect_device((_source, result) =>
				log_error(
					attempt(() => device.connect_device_finish(result)),
					"bluetooth.device: Failed to connect",
				),
			),
		)
		log_error(started, "bluetooth.device: Failed to start connection")
	}

	function disconnect(device: AstalBluetooth.Device) {
		const started = attempt(() =>
			device.disconnect_device((_source, result) =>
				log_error(
					attempt(() => device.disconnect_device_finish(result)),
					"bluetooth.device: Failed to disconnect",
				),
			),
		)
		log_error(started, "bluetooth.device: Failed to start disconnect")
	}

	function toggle_connection(device: AstalBluetooth.Device) {
		if (device.get_connected()) disconnect(device)
		else connect(device)
	}

	function unpair(device: AstalBluetooth.Device) {
		if (!device.paired || !notify_missing_programs("bluetoothctl")) return
		void attempt_async(() =>
			execAsync(["bluetoothctl", "remove", device.get_address()]),
		).then((result) => log_error(result, "bluetooth.device: Failed to unpair"))
	}

	function set_bluetooth_powered(on: boolean) {
		const adapter = bluetooth.get_adapter()
		if (!adapter) return
		log_error(
			attempt(() => adapter.set_powered(on)),
			"bluetooth.power: Failed to change power",
		)
	}
}
