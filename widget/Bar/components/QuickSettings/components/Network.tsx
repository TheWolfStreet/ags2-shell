import app from "$lib/app"
import { Gdk, Gtk } from "ags/gtk4"
import { idle, timeout } from "$lib/time"
import { createBinding, With, For, createComputed, createState, onCleanup } from "ags"
import { execAsync } from "ags/process"

import AstalNetwork from "gi://AstalNetwork"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import NM from "gi://NM"

import { Placeholder } from "widget/shared/Placeholder"
import { ToggleButton, Menu, SettingsButton, quick_settings_submenu } from "./MenuControls"

import icons from "$lib/icons"
import { attempt, attempt_async, log_error } from "$lib/result"

import options from "$shell/options"

const network = AstalNetwork.get_default()

export namespace Network {
	export namespace Wifi {
		export function Toggle() {
			const wifi = createBinding(network, "wifi")
			return (
				<With value={wifi}>
					{(w) => {
						if (!w)
							return (
								<ToggleButton
									arrow
									name="wifi-selector"
									iconName={icons.wifi.offline}
									label={"No device"}
								/>
							)
						return (
							<ToggleButton
								arrow
								name="wifi-selector"
								iconName={createBinding(w, "iconName")}
								label={createBinding(w, "activeAccessPoint").as(
									(ap) => ap?.ssid || "Not Connected",
								)}
								onArrow={() => {
									if (quick_settings_submenu.opened.peek() !== "wifi-selector") return
									const enabled = attempt(() => w.set_enabled(true))
									if (!log_error(enabled, "network.wifi: Failed to enable Wi-Fi")) return
									timeout(100, () => {
										if (network.wifi === w && w.enabled)
											log_error(attempt(() => w.scan()), "network.wifi: Failed to scan")
									})
								}}
								onToggle={() => {
									if (w.enabled) log_error(attempt(() => w.set_enabled(false)), "network.wifi: Failed to disable Wi-Fi")
									else {
										const enabled = attempt(() => w.set_enabled(true))
										if (!log_error(enabled, "network.wifi: Failed to enable Wi-Fi")) return
										timeout(100, () => {
											if (network.wifi === w && w.enabled)
												log_error(attempt(() => w.scan()), "network.wifi: Failed to scan")
										})
									}
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
					iconName={wifi.as((w) => (w ? w.iconName : icons.wifi.offline))}
					title="Visible networks"
					children={
						<With value={wifi}>
							{(wifi) => {
								if (!wifi)
									return (
										<Placeholder
											iconName={icons.wifi.offline}
											label="No device found"
										/>
									)

								const aps = createBinding(wifi, "accessPoints").as((aps) => {
									const best = new Map()

									for (const ap of aps) {
										if (!ap.ssid) continue

										const prev = best.get(ap.ssid)
										if (!prev || ap.strength > prev.strength) {
											best.set(ap.ssid, ap)
										}
									}

									return Array.from(best.values()).sort(
										(a, b) => b.strength - a.strength,
									)
								})

								const has_aps = aps.as((aps) => aps.length > 0)

								return (
									<box orientation={VERTICAL}>
										<revealer
											halign={CENTER}
											revealChild={has_aps.as((v) => !v)}
											transitionDuration={options.transition.duration}
										>
											<Placeholder
												iconName={icons.wifi.scanning}
												label={has_aps.as((v) =>
													v ? "" : "Searching for Wi-Fi networks...",
												)}
											/>
										</revealer>
										<revealer
											revealChild={has_aps}
											transitionDuration={options.transition.duration}
										>
											<Gtk.ScrolledWindow
												class="device-scroll"
												hscrollbarPolicy={NEVER}
											>
												<box orientation={VERTICAL} vexpand hexpand>
													<For each={aps}>{(ap) => <Item ap={ap} />}</For>
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
													"wifi",
												])).then((result) => log_error(result, "network.settings: Failed to open Wi-Fi settings"))
											}
										/>
									</box>
								)
							}}
						</With>
					}
				/>
			)
		}

		export function Window() {
			const connecting = authentication.as(
				(state) => state.phase === "checking",
			)
			const status = authentication.as(
				(state) => authentication_message[state.phase],
			)
			const handle_connect = async () => {
				let sequence = activation_sequence
				try {
					const { ap, password } = authentication.peek()
					if (!ap) return

					sequence = await begin_activation()
					if (sequence !== activation_sequence) return
					set_authentication((state) => ({
						...state,
						phase: "checking",
						shake: false,
					}))

					await activate_and_watch(ap, password || null, sequence, true)
				} catch (error) {
					if (sequence !== activation_sequence) return
					if (is_invalid_password_error(error)) reject_password()
					else {
						set_authentication((state) => ({ ...state, phase: "failed" }))
						console.error("Failed to connect to WiFi:", error)
					}
				}
			}

			const handle_cancel = () => {
				void begin_activation()
				app.get_window("wifi-auth")?.hide()
				set_authentication(idle_authentication)
			}
			onCleanup(() => {
				password_entry = null
				void begin_activation()
			})

			return (
				<Gtk.Window
					title="WIFI Authentication"
					name="wifi-auth"
					application={app}
					hideOnClose
					onCloseRequest={() => { handle_cancel(); return true }}
					iconName={icons.wifi.enabled}
				>
					<box class="vertical auth-content" orientation={VERTICAL}>
						<box class="header horizontal" orientation={HORIZONTAL}>
							<button
								onClicked={handle_cancel}
								sensitive
							>
								<label label="Cancel" />
							</button>
							<label
								label={authentication.as((state) => state.ap?.ssid ?? "")}
								hexpand
								halign={CENTER}
							/>
							<button
								onClicked={handle_connect}
								sensitive={connecting.as((value) => !value)}
							>
								<label
									label={connecting.as((value) =>
										value ? "Connecting..." : "Connect",
									)}
								/>
							</button>
						</box>

						<box
							class="entry-row"
							vexpand
							valign={START}
							orientation={HORIZONTAL}
						>
							<entry
								class={authentication.as((state) =>
									state.shake ? "shake" : "",
								)}
								placeholderText="Enter password"
								visibility={authentication.as((state) => state.password_visible)}
								hexpand
								text={authentication.as((state) => state.password)}
								onNotifyText={(self) =>
									set_authentication((state) => ({
										...state,
										password: self.text,
									}))
								}
								onActivate={handle_connect}
								sensitive={connecting.as((value) => !value)}
								$={(self) => {
									password_entry = self
								}}
							/>
							<button
								onClicked={() =>
									set_authentication((state) => ({
										...state,
										password_visible: !state.password_visible,
									}))
								}
								tooltipText={authentication.as((state) =>
									state.password_visible ? "Hide password" : "Show password",
								)}
							>
								<image
									iconName={authentication.as((state) =>
										state.password_visible ? icons.ui.hidden : icons.ui.eye,
									)}
								/>
							</button>
						</box>
						<label
							class={authentication.as(
								(state) =>
									`auth-status${state.phase === "invalid" ? " invalid" : ""}`,
							)}
							label={status}
							visible={status.as((message) => message.length > 0)}
							halign={START}
						/>
					</box>
				</Gtk.Window>
			)
		}

		function Item({ ap }: { ap: AstalNetwork.AccessPoint }) {
			const security = security_warning(ap)
			const forget_tooltip = createBinding(network.client, "connections").as(
				() =>
					find_saved_access_point(ap) ? "Middle click to forget network" : "",
			)
			const handle_click = async () => {
				let sequence = activation_sequence
				try {
					sequence = await begin_activation()
					if (sequence !== activation_sequence) return
					const current = resolve_access_point(ap)
					if (!current) {
						set_authentication(idle_authentication)
						console.warn("Wi-Fi access point is no longer available")
						return
					}
					const saved = find_saved_access_point(current)

					if (is_personal_network(current) && !saved) {
						show_authentication(current)
						return
					}

					await activate_and_watch(saved ?? current, null, sequence, false)
				} catch (error) {
					if (sequence !== activation_sequence) return
					if (is_invalid_password_error(error)) {
						const current = resolve_access_point(ap)
						if (current) show_authentication(current)
					} else {
						set_authentication(idle_authentication)
						console.error("Failed to connect to WiFi:", error)
					}
				}
			}

			return (
				<button onClicked={handle_click} tooltipText={forget_tooltip}>
					<Gtk.GestureClick
						button={BUTTON_MIDDLE}
						onPressed={(gesture) => {
							const current = resolve_access_point(ap)
							const saved = current && find_saved_access_point(current)
							const connection = saved && find_saved_connection(saved)
							if (connection)
								void delete_connection(connection).catch((error) =>
									console.error("Failed to forget Wi-Fi network:", error),
								)
							gesture.reset()
						}}
					/>
					<box class="wifi-item horizontal">
						<image iconName={createBinding(ap, "iconName")} />
						<label
							label={createBinding(ap, "ssid").as((v) => v || "Hidden network")}
						/>
						<box hexpand />
						<label
							class="device-detail security-warning"
							label={security}
							visible={security.length > 0}
						/>
						<label class="device-detail" label={frequency_band(ap.frequency)} />
						<image
							iconName={icons.ui.tick}
							halign={END}
							opacity={createBinding(network, "wifi", "activeAccessPoint").as(
								(v) => (v?.ssid === ap.ssid ? 1 : 0),
							)}
						/>
					</box>
				</button>
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
				case WIFI:
					return wifi()

				case WIRED:
					return wired()

				default:
					return undefined
			}
		})

		return (
			<box visible={adapter.as((v) => v !== undefined)}>
				<With value={adapter}>
					{(adapter) =>
						adapter && (
							<image
								iconName={createBinding(adapter, "iconName")}
								useFallback
							/>
						)
					}
				</With>
			</box>
		)
	}
}

const { CENTER, END, START } = Gtk.Align
const { VERTICAL, HORIZONTAL } = Gtk.Orientation
const { NEVER } = Gtk.PolicyType
const { BUTTON_MIDDLE } = Gdk

type authentication_phase = "idle" | "checking" | "invalid" | "failed"
type authentication_state = {
	ap: AstalNetwork.AccessPoint | null
	password: string
	password_visible: boolean
	phase: authentication_phase
	shake: boolean
}

const idle_authentication: authentication_state = {
	ap: null,
	password: "",
	password_visible: false,
	phase: "idle",
	shake: false,
}
const [authentication, set_authentication] = createState(idle_authentication)

const authentication_message: Record<authentication_phase, string> = {
	idle: "",
	checking: "Checking password...",
	invalid: "Incorrect password. Try again.",
	failed: "Could not connect. Try again.",
}

type activation_transaction = {
	active: NM.ActiveConnection
	persist: () => Promise<void>
	rollback: () => Promise<void>
}

const ap_security_flags = (
	NM as unknown as {
		"80211ApSecurityFlags": {
			KEY_MGMT_PSK: number
			KEY_MGMT_SAE: number
		}
	}
)["80211ApSecurityFlags"]

let activation_watcher_cleanup: (() => void) | null = null
let activation_sequence = 0
let password_entry: Gtk.Entry | null = null
let pending_transaction: activation_transaction | null = null
let activation_cancellable: Gio.Cancellable | null = null
let pending_settlement: Promise<void> = Promise.resolve()
let pending_activation: Promise<void> = Promise.resolve()

function disconnect_activation_watcher() {
	const cleanup = activation_watcher_cleanup
	activation_watcher_cleanup = null
	cleanup?.()
}

async function begin_activation() {
	activation_sequence += 1
	const sequence = activation_sequence
	activation_cancellable?.cancel()
	activation_cancellable = new Gio.Cancellable()
	disconnect_activation_watcher()
	await pending_activation
	await pending_settlement
	if (sequence !== activation_sequence) return sequence
	const transaction = pending_transaction
	pending_transaction = null
	if (transaction) {
		try {
			await transaction.rollback()
		} catch (error) {
			console.error("Failed to cancel superseded Wi-Fi activation:", error)
		}
	}
	return sequence
}

function is_personal_network(ap: AstalNetwork.AccessPoint) {
	const personal = ap_security_flags.KEY_MGMT_PSK | ap_security_flags.KEY_MGMT_SAE
	return ((ap.wpaFlags | ap.rsnFlags) & personal) !== 0
}

function security_warning(ap: AstalNetwork.AccessPoint) {
	if (ap.rsnFlags) return ""
	if (ap.wpaFlags) return "WPA"
	return ap.requiresPassword ? "WEP" : "Open"
}

function frequency_band(frequency: number) {
	if (frequency >= 5925) return "6 GHz"
	if (frequency >= 4900) return "5 GHz"
	return "2.4 GHz"
}

function resolve_access_point(ap: AstalNetwork.AccessPoint) {
	return (
		network.wifi?.accessPoints.find(
			(candidate) => candidate.bssid === ap.bssid,
		) ?? null
	)
}

function is_active_network(
	wifi: AstalNetwork.Wifi,
	ap: AstalNetwork.AccessPoint,
) {
	const active_bssid = wifi.device.get_active_access_point()?.get_bssid()
	return active_bssid === ap.bssid
}

function find_saved_connection(ap: AstalNetwork.AccessPoint) {
	const wifi = network.wifi
	if (!wifi) return null
	const native_ap = wifi.device.get_access_point_by_path(ap.get_path())
	if (!native_ap) return null
	let fallback: NM.RemoteConnection | null = null

	for (const connection of network.client.get_connections()) {
		if (
			(connection.get_flags() & NM.SettingsConnectionFlags.VOLATILE) !== 0 ||
			!wifi.device.connection_valid(connection) ||
			!native_ap.connection_valid(connection)
		)
			continue
		const wireless = connection.get_setting_wireless()
		if (wireless?.bssid === ap.bssid) return connection
		if (!wireless?.bssid) fallback ??= connection
	}

	return fallback
}

function find_saved_access_point(ap: AstalNetwork.AccessPoint) {
	const wifi = network.wifi
	if (!wifi || !ap.ssid) return null
	let best: AstalNetwork.AccessPoint | null = null

	for (const candidate of wifi.accessPoints) {
		if (candidate.ssid !== ap.ssid || !find_saved_connection(candidate)) continue
		if (!best || candidate.strength > best.strength) best = candidate
	}

	return best
}

function reject_password() {
	set_authentication((state) => ({
		...state,
		password: "",
		phase: "invalid",
		shake: false,
	}))
	const sequence = activation_sequence
	idle(() => {
		if (sequence !== activation_sequence || !authentication.peek().ap) return
		set_authentication((state) => ({ ...state, shake: true }))
		password_entry?.grab_focus()
		timeout(450, () => {
			if (sequence === activation_sequence) set_authentication((state) => ({ ...state, shake: false }))
		})
	})
}

function show_authentication(ap: AstalNetwork.AccessPoint) {
	const current = resolve_access_point(ap)
	if (!current) {
		set_authentication(idle_authentication)
		return
	}

	set_authentication({ ...idle_authentication, ap: current })
	app.get_window("wifi-auth")?.show()
}

function is_credential_failure(
	ap: AstalNetwork.AccessPoint,
	state: AstalNetwork.DeviceState,
	reason: NM.DeviceStateReason,
) {
	if (!is_personal_network(ap)) return false

	return (
		(state === AstalNetwork.DeviceState.NEED_AUTH &&
			(reason === NM.DeviceStateReason.SUPPLICANT_DISCONNECT ||
				reason === NM.DeviceStateReason.NO_SECRETS)) ||
		(state === AstalNetwork.DeviceState.FAILED &&
			reason === NM.DeviceStateReason.NO_SECRETS)
	)
}

function is_invalid_password_error(error: unknown) {
	return (
		error instanceof NM.ConnectionError &&
		error.code === NM.ConnectionError.INVALIDPROPERTY &&
		error.message.startsWith("802-11-wireless-security.psk:")
	)
}

function commit_connection(connection: NM.RemoteConnection) {
	const cancellable = new Gio.Cancellable()
	const deadline = timeout(10_000, () => cancellable.cancel())
	return new Promise<void>((resolve, reject) => {
		connection.commit_changes_async(true, cancellable, (source, result) => {
			deadline.cancel()
			try {
				connection.commit_changes_finish(result)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	})
}

function delete_connection(connection: NM.RemoteConnection) {
	const cancellable = new Gio.Cancellable()
	const deadline = timeout(10_000, () => cancellable.cancel())
	return new Promise<void>((resolve, reject) => {
		connection.delete_async(cancellable, (source, result) => {
			deadline.cancel()
			try {
				connection.delete_finish(result)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	})
}

function activate_connection(
	connection: NM.Connection,
	ap: AstalNetwork.AccessPoint,
	cancellable: Gio.Cancellable,
) {
	const wifi = network.wifi
	if (!wifi) return Promise.reject(new Error("No Wi-Fi device available"))

	return new Promise<NM.ActiveConnection>((resolve, reject) => {
		network.client.activate_connection_async(
			connection,
			wifi.device,
			ap.get_path(),
			cancellable,
			(source, result) => {
				try {
					resolve(network.client.activate_connection_finish(result))
				} catch (error) {
					reject(error)
				}
			},
		)
	})
}

function add_and_activate_connection(
	connection: NM.Connection | null,
	ap: AstalNetwork.AccessPoint,
	cancellable: Gio.Cancellable,
	volatile = false,
) {
	const wifi = network.wifi
	if (!wifi) return Promise.reject(new Error("No Wi-Fi device available"))

	return new Promise<NM.ActiveConnection>((resolve, reject) => {
		const options = new GLib.Variant(
			"a{sv}",
			volatile ? { persist: new GLib.Variant("s", "volatile") } : {},
		)
		network.client.add_and_activate_connection2(
			connection,
			wifi.device,
			ap.get_path(),
			options,
			cancellable,
			(source, result) => {
				try {
					const [active] =
						network.client.add_and_activate_connection2_finish(result)
					resolve(active)
				} catch (error) {
					reject(error)
				}
			},
		)
	})
}

function deactivate_connection(active: NM.ActiveConnection): Promise<void> {
	const cancellable = new Gio.Cancellable()
	const deadline = timeout(10_000, () => cancellable.cancel())
	return new Promise((resolve, reject) => {
		network.client.deactivate_connection_async(active, cancellable, (source, result) => {
			deadline.cancel()
			try {
				network.client.deactivate_connection_finish(result)
				resolve()
			} catch (error) { reject(error) }
		})
	})
}

function create_personal_connection(
	ap: AstalNetwork.AccessPoint,
	password: string,
) {
	const connection = NM.SimpleConnection.new()
	const wireless = NM.SettingWireless.new()
	wireless.set_property(
		"ssid",
		new GLib.Bytes(new TextEncoder().encode(ap.ssid ?? "")),
	)
	connection.add_setting(wireless)

	const security = NM.SettingWirelessSecurity.new()
	const supports_psk =
		((ap.wpaFlags | ap.rsnFlags) & ap_security_flags.KEY_MGMT_PSK) !== 0
	security.set_property("key-mgmt", supports_psk ? "wpa-psk" : "sae")
	security.set_property("psk", password)
	connection.add_setting(security)
	return connection
}

async function activate_access_point(
	ap: AstalNetwork.AccessPoint,
	password: string | null,
	cancellable: Gio.Cancellable,
): Promise<activation_transaction> {
	const current = resolve_access_point(ap)
	if (!current) throw new Error("Wi-Fi access point is no longer available")
	const connection = find_saved_connection(current)

	if (connection) {
		if (password) {
			const candidate = NM.SimpleConnection.new_clone(connection)
			const candidate_settings = candidate.get_setting_connection()
			const candidate_security = candidate.get_setting_wireless_security()
			const saved_security = connection.get_setting_wireless_security()
			if (!candidate_settings || !candidate_security || !saved_security)
				throw new Error("Saved Wi-Fi connection has incomplete settings")

			candidate_settings.set_property("uuid", GLib.uuid_string_random())
			candidate_security.set_property("psk", password)
			const active = await add_and_activate_connection(candidate, current, cancellable, true)
			const temporary = active.get_connection()
			return {
				active,
				persist: async () => {
					const old_password = saved_security.get_psk()
					try {
						saved_security.set_property("psk", password)
						await commit_connection(connection)
					} catch (error) {
						saved_security.set_property("psk", old_password)
						throw error
					}
				},
				rollback: async () => {
					try { await deactivate_connection(active) }
					finally { await delete_connection(temporary) }
				},
			} satisfies activation_transaction
		}

		const active = await activate_connection(connection, current, cancellable)
		return { active, persist: async () => {}, rollback: () => deactivate_connection(active) }
	}

	if (is_personal_network(current)) {
		if (!password)
			throw new Error("A password is required for this Wi-Fi network")
		const active = await add_and_activate_connection(
			create_personal_connection(current, password),
			current,
			cancellable,
			true,
		)
		const created = active.get_connection()
		return {
			active,
			persist: () => commit_connection(created),
			rollback: async () => {
				try { await deactivate_connection(active) }
				finally { await delete_connection(created) }
			},
		} satisfies activation_transaction
	}

	const active = await add_and_activate_connection(null, current, cancellable)
	const created = active.get_connection()
	return {
		active,
		persist: async () => {},
		rollback: async () => {
			try { await deactivate_connection(active) }
			finally { await delete_connection(created) }
		},
	}
}

async function activate_and_watch(
	ap: AstalNetwork.AccessPoint,
	password: string | null,
	sequence: number,
	authentication_open: boolean,
) {
	const cancellable = activation_cancellable
	if (!cancellable) return
	const deadline = timeout(25_000, () => cancellable.cancel())
	const activation = (async () => {
		try {
			const transaction = await activate_access_point(ap, password, cancellable)
			if (sequence === activation_sequence)
				watch_activation(ap, sequence, authentication_open, transaction)
			else await transaction.rollback()
		} finally { deadline.cancel() }
	})()
	pending_activation = activation.then(() => undefined, () => undefined)
	await activation
}

function watch_activation(
	ap: AstalNetwork.AccessPoint,
	sequence: number,
	authentication_open: boolean,
	transaction: activation_transaction,
) {
	if (sequence !== activation_sequence) return
	disconnect_activation_watcher()
	const wifi = network.wifi
	if (!wifi) {
		pending_settlement = transaction.rollback().then(() => {
			if (sequence === activation_sequence && authentication_open)
				set_authentication((state) => ({ ...state, phase: "failed" }))
		}).catch((error) => {
			console.error("Failed to cancel Wi-Fi activation:", error)
			if (sequence === activation_sequence && authentication_open)
				set_authentication((state) => ({ ...state, phase: "failed" }))
		})
		return
	}
	pending_transaction = transaction
	const settle = async (persist: boolean) => {
		if (pending_transaction === transaction) pending_transaction = null
		pending_settlement = (async () => {
			try {
				await transaction[persist ? "persist" : "rollback"]()
			} catch (error) {
				if (persist) {
					try { await transaction.rollback() }
					catch (rollback_error) { console.error("Failed to cancel unsaved Wi-Fi connection:", rollback_error) }
				}
				throw error
			}
		})()
		try {
			await pending_settlement
			return true
		} catch (error) {
			console.error(`Failed to ${persist ? "save" : "restore"} Wi-Fi connection:`, error)
			return false
		} finally { pending_settlement = Promise.resolve() }
	}
	const update = async (
		state: AstalNetwork.DeviceState,
		reason: NM.DeviceStateReason,
	) => {
		if (sequence !== activation_sequence) return

		if (is_credential_failure(ap, state, reason)) {
			disconnect_activation_watcher()
			await settle(false)
			if (sequence !== activation_sequence) return
			if (authentication_open) reject_password()
			else show_authentication(ap)
			return
		}

		const active_connection = wifi.device.get_active_connection()
		const activated = state === AstalNetwork.DeviceState.ACTIVATED &&
			active_connection?.get_path() === transaction.active.get_path()
		if (activated && !is_active_network(wifi, ap)) return
		if (!activated && state !== AstalNetwork.DeviceState.FAILED) return

		disconnect_activation_watcher()
		const settled = await settle(activated)
		if (sequence !== activation_sequence) return

		if (activated && settled) {
			if (authentication_open) app.get_window("wifi-auth")?.hide()
			set_authentication(idle_authentication)
		} else if (authentication_open) {
			set_authentication((state) => ({ ...state, phase: "failed" }))
		} else {
			set_authentication(idle_authentication)
		}
	}

	const state_changed_id = wifi.connect(
		"state-changed",
		(source_wifi, new_state, old_state, reason) => {
			void update(new_state, reason)
		},
	)
	const enabled_id = wifi.connect("notify::enabled", () => {
		if (!wifi.enabled) void update(AstalNetwork.DeviceState.FAILED, NM.DeviceStateReason.UNKNOWN)
	})
	const wifi_id = network.connect("notify::wifi", () => {
		if (network.wifi !== wifi) void update(AstalNetwork.DeviceState.FAILED, NM.DeviceStateReason.UNKNOWN)
	})
	const deadline = timeout(25_000, () => void update(AstalNetwork.DeviceState.FAILED, NM.DeviceStateReason.UNKNOWN))
	activation_watcher_cleanup = () => {
		wifi.disconnect(state_changed_id)
		wifi.disconnect(enabled_id)
		network.disconnect(wifi_id)
		deadline.cancel()
	}

	void update(wifi.state, wifi.device.get_state_reason())
}

app.connect("shutdown", () => {
	void begin_activation()
})
