// Lists Wi-Fi and wired devices and shows connection and password controls.

import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import { idle, timeout } from "ags/time"
import { createBinding, With, For, createComputed, createState } from "ags"
import { execAsync } from "ags/process"

import AstalNetwork from "gi://AstalNetwork"
import GLib from "gi://GLib"
import NM from "gi://NM"

import { Placeholder } from "widget/shared/Placeholder"
import { ToggleButton, Menu, SettingsButton } from "./MenuControls"

import icons from "$lib/icons"

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
								activateOnArrow={true}
								activate={() => {
									w.set_enabled(true)
									timeout(100, () => {
										w.scan()
									})
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

								const hasAps = aps.as((aps) => aps.length > 0)

								return (
									<box orientation={VERTICAL}>
										<revealer
											halign={CENTER}
											revealChild={hasAps.as((v) => !v)}
											transitionDuration={options.transition.duration}
										>
											<Placeholder
												iconName={icons.wifi.scanning}
												label={hasAps.as((v) =>
													v ? "" : "Searching for Wi-Fi networks...",
												)}
											/>
										</revealer>
										<revealer
											revealChild={hasAps}
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
												void execAsync([
													"env",
													"XDG_CURRENT_DESKTOP=GNOME",
													"gnome-control-center",
													"wifi",
												])
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
				(state) => authenticationMessage[state.phase],
			)
			const handleConnect = async () => {
				let sequence = activationSequence
				try {
					const { ap, password } = authentication.peek()
					if (!ap) return

					sequence = await beginActivation()
					if (sequence !== activationSequence) return
					setAuthentication((state) => ({
						...state,
						phase: "checking",
						shake: false,
					}))

					await activateAndWatch(ap, password || null, sequence, true)
				} catch (error) {
					if (sequence !== activationSequence) return
					if (isInvalidPasswordError(error)) rejectPassword()
					else {
						setAuthentication((state) => ({ ...state, phase: "failed" }))
						console.error("Failed to connect to WiFi:", error)
					}
				}
			}

			const handleCancel = () => {
				void beginActivation()
				app.get_window("wifi-auth")?.hide()
				setAuthentication(idleAuthentication)
			}

			return (
				<Gtk.Window
					title="WIFI Authentication"
					name="wifi-auth"
					application={app}
					hideOnClose
					iconName={icons.wifi.enabled}
				>
					<box class="vertical auth-content" orientation={VERTICAL}>
						<box class="header horizontal" orientation={HORIZONTAL}>
							<button
								onClicked={handleCancel}
								sensitive={connecting.as((value) => !value)}
							>
								<label label="Cancel" />
							</button>
							<label
								label={authentication.as((state) => state.ap?.ssid ?? "")}
								hexpand
								halign={CENTER}
							/>
							<button
								onClicked={handleConnect}
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
								visibility={authentication.as((state) => state.passwordVisible)}
								hexpand
								text={authentication.as((state) => state.password)}
								onNotifyText={(self) =>
									setAuthentication((state) => ({
										...state,
										password: self.text,
									}))
								}
								onActivate={handleConnect}
								sensitive={connecting.as((value) => !value)}
								$={(self) => {
									passwordEntry = self
								}}
							/>
							<button
								onClicked={() =>
									setAuthentication((state) => ({
										...state,
										passwordVisible: !state.passwordVisible,
									}))
								}
								tooltipText={authentication.as((state) =>
									state.passwordVisible ? "Hide password" : "Show password",
								)}
							>
								<image
									iconName={authentication.as((state) =>
										state.passwordVisible ? icons.ui.hidden : icons.ui.eye,
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
			const security = securityWarning(ap)
			const forgetTooltip = createBinding(network.client, "connections").as(
				() =>
					findSavedAccessPoint(ap) ? "Middle click to forget network" : "",
			)
			const handleClick = async () => {
				let sequence = activationSequence
				try {
					sequence = await beginActivation()
					if (sequence !== activationSequence) return
					const current = resolveAccessPoint(ap)
					if (!current) return
					const saved = findSavedAccessPoint(current)

					if (isPersonalNetwork(current) && !saved) {
						showAuthentication(current)
						return
					}

					await activateAndWatch(saved ?? current, null, sequence, false)
				} catch (error) {
					if (sequence !== activationSequence) return
					if (isInvalidPasswordError(error)) {
						const current = resolveAccessPoint(ap)
						if (current) showAuthentication(current)
					} else {
						setAuthentication(idleAuthentication)
						console.error("Failed to connect to WiFi:", error)
					}
				}
			}

			return (
				<button onClicked={handleClick} tooltipText={forgetTooltip}>
					<Gtk.GestureClick
						button={BUTTON_MIDDLE}
						onPressed={(gesture) => {
							const current = resolveAccessPoint(ap)
							const saved = current && findSavedAccessPoint(current)
							const connection = saved && findSavedConnection(saved)
							if (connection)
								void deleteConnection(connection).catch((error) =>
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
						<label class="device-detail" label={frequencyBand(ap.frequency)} />
						<image
							iconName={icons.ui.tick}
							halign={END}
							opacity={createBinding(network.wifi, "activeAccessPoint").as(
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

type AuthenticationPhase = "idle" | "checking" | "invalid" | "failed"
type AuthenticationState = {
	ap: AstalNetwork.AccessPoint | null
	password: string
	passwordVisible: boolean
	phase: AuthenticationPhase
	shake: boolean
}

const idleAuthentication: AuthenticationState = {
	ap: null,
	password: "",
	passwordVisible: false,
	phase: "idle",
	shake: false,
}
const [authentication, setAuthentication] = createState(idleAuthentication)

const authenticationMessage: Record<AuthenticationPhase, string> = {
	idle: "",
	checking: "Checking password...",
	invalid: "Incorrect password. Try again.",
	failed: "Could not connect. Try again.",
}

type ActivationTransaction = {
	persist: () => Promise<void>
	rollback: () => Promise<void>
}

const apSecurityFlags = (
	NM as unknown as {
		"80211ApSecurityFlags": {
			KEY_MGMT_PSK: number
			KEY_MGMT_SAE: number
		}
	}
)["80211ApSecurityFlags"]

let activationWatcherCleanup: (() => void) | null = null
let activationSequence = 0
let passwordEntry: Gtk.Entry | null = null
let pendingTransaction: ActivationTransaction | null = null

function disconnectActivationWatcher() {
	const cleanup = activationWatcherCleanup
	activationWatcherCleanup = null
	cleanup?.()
}

async function beginActivation() {
	activationSequence += 1
	const sequence = activationSequence
	disconnectActivationWatcher()
	const transaction = pendingTransaction
	pendingTransaction = null
	if (transaction) {
		try {
			await transaction.rollback()
		} catch (error) {
			console.error("Failed to cancel superseded Wi-Fi activation:", error)
		}
	}
	return sequence
}

function isPersonalNetwork(ap: AstalNetwork.AccessPoint) {
	const personal = apSecurityFlags.KEY_MGMT_PSK | apSecurityFlags.KEY_MGMT_SAE
	return ((ap.wpaFlags | ap.rsnFlags) & personal) !== 0
}

function securityWarning(ap: AstalNetwork.AccessPoint) {
	if (ap.rsnFlags) return ""
	if (ap.wpaFlags) return "WPA"
	return ap.requiresPassword ? "WEP" : "Open"
}

function frequencyBand(frequency: number) {
	if (frequency >= 5925) return "6 GHz"
	if (frequency >= 4900) return "5 GHz"
	return "2.4 GHz"
}

function resolveAccessPoint(ap: AstalNetwork.AccessPoint) {
	return (
		network.wifi?.accessPoints.find(
			(candidate) => candidate.bssid === ap.bssid,
		) ?? null
	)
}

function isActiveNetwork(
	wifi: AstalNetwork.Wifi,
	ap: AstalNetwork.AccessPoint,
) {
	const activeBssid = wifi.device.get_active_access_point()?.get_bssid()
	return activeBssid === ap.bssid
}

function findSavedConnection(ap: AstalNetwork.AccessPoint) {
	const wifi = network.wifi
	if (!wifi) return null
	const nativeAp = wifi.device.get_access_point_by_path(ap.get_path())
	if (!nativeAp) return null
	let fallback: NM.RemoteConnection | null = null

	for (const connection of network.client.get_connections()) {
		if (
			!wifi.device.connection_valid(connection) ||
			!nativeAp.connection_valid(connection)
		)
			continue
		const wireless = connection.get_setting_wireless()
		if (wireless?.bssid === ap.bssid) return connection
		if (!wireless?.bssid) fallback ??= connection
	}

	return fallback
}

function findSavedAccessPoint(ap: AstalNetwork.AccessPoint) {
	const wifi = network.wifi
	if (!wifi || !ap.ssid) return null
	let best: AstalNetwork.AccessPoint | null = null

	for (const candidate of wifi.accessPoints) {
		if (candidate.ssid !== ap.ssid || !findSavedConnection(candidate)) continue
		if (!best || candidate.strength > best.strength) best = candidate
	}

	return best
}

function rejectPassword() {
	setAuthentication((state) => ({
		...state,
		password: "",
		phase: "invalid",
		shake: false,
	}))
	const sequence = activationSequence
	idle(() => {
		if (sequence !== activationSequence || !authentication.peek().ap) return
		setAuthentication((state) => ({ ...state, shake: true }))
		passwordEntry?.grab_focus()
		timeout(450, () => {
			setAuthentication((state) => ({ ...state, shake: false }))
		})
	})
}

function showAuthentication(ap: AstalNetwork.AccessPoint) {
	const current = resolveAccessPoint(ap)
	if (!current) {
		setAuthentication(idleAuthentication)
		return
	}

	setAuthentication({ ...idleAuthentication, ap: current })
	app.get_window("wifi-auth")?.show()
}

function isCredentialFailure(
	ap: AstalNetwork.AccessPoint,
	state: AstalNetwork.DeviceState,
	reason: NM.DeviceStateReason,
) {
	if (!isPersonalNetwork(ap)) return false

	return (
		(state === AstalNetwork.DeviceState.NEED_AUTH &&
			(reason === NM.DeviceStateReason.SUPPLICANT_DISCONNECT ||
				reason === NM.DeviceStateReason.NO_SECRETS)) ||
		(state === AstalNetwork.DeviceState.FAILED &&
			reason === NM.DeviceStateReason.NO_SECRETS)
	)
}

function isInvalidPasswordError(error: unknown) {
	return (
		error instanceof NM.ConnectionError &&
		error.code === NM.ConnectionError.INVALIDPROPERTY &&
		error.message.startsWith("802-11-wireless-security.psk:")
	)
}

function commitConnection(connection: NM.RemoteConnection) {
	return new Promise<void>((resolve, reject) => {
		connection.commit_changes_async(true, null, (_source, result) => {
			try {
				connection.commit_changes_finish(result)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	})
}

function deleteConnection(connection: NM.RemoteConnection) {
	return new Promise<void>((resolve, reject) => {
		connection.delete_async(null, (_source, result) => {
			try {
				connection.delete_finish(result)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	})
}

function activateConnection(
	connection: NM.Connection,
	ap: AstalNetwork.AccessPoint,
) {
	const wifi = network.wifi
	if (!wifi) return Promise.reject(new Error("No Wi-Fi device available"))

	return new Promise<void>((resolve, reject) => {
		network.client.activate_connection_async(
			connection,
			wifi.device,
			ap.get_path(),
			null,
			(_source, result) => {
				try {
					network.client.activate_connection_finish(result)
					resolve()
				} catch (error) {
					reject(error)
				}
			},
		)
	})
}

function addAndActivateConnection(
	connection: NM.Connection | null,
	ap: AstalNetwork.AccessPoint,
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
			null,
			(_source, result) => {
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

function createPersonalConnection(
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
	const supportsPsk =
		((ap.wpaFlags | ap.rsnFlags) & apSecurityFlags.KEY_MGMT_PSK) !== 0
	security.set_property("key-mgmt", supportsPsk ? "wpa-psk" : "sae")
	security.set_property("psk", password)
	connection.add_setting(security)
	return connection
}

async function activateAccessPoint(
	ap: AstalNetwork.AccessPoint,
	password: string | null,
) {
	const current = resolveAccessPoint(ap)
	if (!current) throw new Error("Wi-Fi access point is no longer available")
	const connection = findSavedConnection(current)

	if (connection) {
		if (password) {
			const candidate = NM.SimpleConnection.new_clone(connection)
			const candidateSettings = candidate.get_setting_connection()
			const candidateSecurity = candidate.get_setting_wireless_security()
			const savedSecurity = connection.get_setting_wireless_security()
			if (!candidateSettings || !candidateSecurity || !savedSecurity)
				throw new Error("Saved Wi-Fi connection has incomplete settings")

			candidateSettings.set_property("uuid", GLib.uuid_string_random())
			candidateSecurity.set_property("psk", password)
			const active = await addAndActivateConnection(candidate, current, true)
			const temporary = active.get_connection()
			return {
				persist: async () => {
					savedSecurity.set_property("psk", password)
					await commitConnection(connection)
				},
				rollback: () => deleteConnection(temporary),
			} satisfies ActivationTransaction
		}

		await activateConnection(connection, current)
		return null
	}

	if (isPersonalNetwork(current)) {
		if (!password)
			throw new Error("A password is required for this Wi-Fi network")
		const active = await addAndActivateConnection(
			createPersonalConnection(current, password),
			current,
			true,
		)
		const created = active.get_connection()
		return {
			persist: () => commitConnection(created),
			rollback: () => deleteConnection(created),
		} satisfies ActivationTransaction
	}

	await addAndActivateConnection(null, current)
	return null
}

async function activateAndWatch(
	ap: AstalNetwork.AccessPoint,
	password: string | null,
	sequence: number,
	authenticationOpen: boolean,
) {
	const transaction = await activateAccessPoint(ap, password)
	if (sequence === activationSequence)
		watchActivation(ap, sequence, authenticationOpen, transaction)
	else await transaction?.rollback()
}

function watchActivation(
	ap: AstalNetwork.AccessPoint,
	sequence: number,
	authenticationOpen: boolean,
	transaction: ActivationTransaction | null,
) {
	if (sequence !== activationSequence) return
	disconnectActivationWatcher()
	const wifi = network.wifi
	if (!wifi) {
		void transaction
			?.rollback()
			.catch((error) =>
				console.error("Failed to cancel Wi-Fi activation:", error),
			)
		return
	}
	pendingTransaction = transaction
	const settle = (persist: boolean) => {
		if (pendingTransaction === transaction) pendingTransaction = null
		return (
			transaction?.[persist ? "persist" : "rollback"]().catch((error) =>
				console.error(
					`Failed to ${persist ? "save" : "restore"} Wi-Fi connection:`,
					error,
				),
			) ?? Promise.resolve()
		)
	}
	const update = async (
		state: AstalNetwork.DeviceState,
		reason: NM.DeviceStateReason,
	) => {
		if (sequence !== activationSequence) return

		if (isCredentialFailure(ap, state, reason)) {
			disconnectActivationWatcher()
			await settle(false)
			if (sequence !== activationSequence) return
			if (authenticationOpen) rejectPassword()
			else showAuthentication(ap)
			return
		}

		const activated = state === AstalNetwork.DeviceState.ACTIVATED
		if (activated && !isActiveNetwork(wifi, ap)) return
		if (!activated && state !== AstalNetwork.DeviceState.FAILED) return

		disconnectActivationWatcher()
		await settle(activated)
		if (sequence !== activationSequence) return

		if (activated) {
			if (authenticationOpen) app.get_window("wifi-auth")?.hide()
			setAuthentication(idleAuthentication)
		} else if (authenticationOpen) {
			setAuthentication((state) => ({ ...state, phase: "failed" }))
		} else {
			setAuthentication(idleAuthentication)
		}
	}

	const stateChangedId = wifi.connect(
		"state-changed",
		(_wifi, newState, _oldState, reason) => {
			void update(newState, reason)
		},
	)
	activationWatcherCleanup = () => wifi.disconnect(stateChangedId)

	void update(wifi.state, wifi.device.get_state_reason())
}

app.connect("shutdown", () => {
	void beginActivation()
})
