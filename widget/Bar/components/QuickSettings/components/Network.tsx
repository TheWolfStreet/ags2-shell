import app from "$lib/app"
import { Gdk, Gtk } from "ags/gtk4"
import { idle, timeout } from "$lib/time"
import {
	createBinding,
	With,
	For,
	createComputed,
	createState,
	onCleanup,
} from "ags"

import AstalNetwork from "gi://AstalNetwork"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import NM from "gi://NM"

import { Placeholder } from "widget/shared/Placeholder"
import {
	ToggleButton,
	Menu,
	SettingsButton,
	open_gnome_settings,
	quick_settings_submenu,
} from "./MenuControls"

import icons from "$lib/icons"
import {
	attempt,
	attempt_async,
	err,
	guard_async,
	log_error,
	ok,
	type result,
} from "$lib/result"

import options from "$shell/options"

const network = AstalNetwork.get_default()
const menu_name = "wifi-selector"
const authentication_window = "wifi-auth"

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
									name={menu_name}
									iconName={icons.wifi.offline}
									label="No device"
								/>
							)
						const enable_and_scan = () => {
							const enabled = attempt(() => w.set_enabled(true))
							if (!log_error(enabled, "network.wifi: Failed to enable Wi-Fi"))
								return
							timeout(100, () => {
								if (network.wifi === w && w.enabled)
									log_error(
										attempt(() => w.scan()),
										"network.wifi: Failed to scan",
									)
							})
						}
						return (
							<ToggleButton
								arrow
								name={menu_name}
								iconName={createBinding(w, "iconName")}
								label={createBinding(w, "activeAccessPoint").as(
									(ap) => ap?.ssid || "Not Connected",
								)}
								onArrow={() => {
									if (quick_settings_submenu.opened.peek() !== menu_name) return
									enable_and_scan()
								}}
								onToggle={() => {
									if (w.enabled)
										log_error(
											attempt(() => w.set_enabled(false)),
											"network.wifi: Failed to disable Wi-Fi",
										)
									else enable_and_scan()
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
					name={menu_name}
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

								const aps = createBinding(wifi, "accessPoints").as(
									strongest_per_network,
								)

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
											callback={() => open_gnome_settings("wifi")}
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
				const { ap, password } = authentication.peek()
				if (!ap) return
				const activated = await run_activation((sequence) => {
					set_authentication((state) => ({
						...state,
						phase: "checking",
						shake: false,
					}))
					return activate_and_watch(ap, password || null, sequence, true)
				})
				if (activated.ok) return
				if (is_invalid_password_error(activated.err)) {
					reject_password()
					return
				}
				fail_authentication()
				log_error(activated, "network.connect: Failed to connect to Wi-Fi")
			}

			const handle_cancel = () => {
				void begin_activation()
				app.get_window(authentication_window)?.hide()
				set_authentication(idle_authentication)
			}
			onCleanup(() => {
				password_entry = null
				void begin_activation()
			})

			return (
				<Gtk.Window
					title="WIFI Authentication"
					name={authentication_window}
					application={app}
					hideOnClose
					onCloseRequest={() => {
						handle_cancel()
						return true
					}}
					iconName={icons.wifi.enabled}
				>
					<box class="vertical auth-content" orientation={VERTICAL}>
						<box class="header horizontal" orientation={HORIZONTAL}>
							<button onClicked={handle_cancel} sensitive>
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
								visibility={authentication.as(
									(state) => state.password_visible,
								)}
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
				const activated = await run_activation((sequence) =>
					connect_access_point(ap, sequence),
				)
				if (activated.ok) return
				if (is_invalid_password_error(activated.err)) {
					const current = resolve_access_point(ap)
					if (current) show_authentication(current)
					return
				}
				set_authentication(idle_authentication)
				log_error(activated, "network.connect: Failed to connect to Wi-Fi")
			}

			return (
				<button onClicked={handle_click} tooltipText={forget_tooltip}>
					<Gtk.GestureClick
						button={BUTTON_MIDDLE}
						onPressed={(gesture) => {
							forget_access_point(ap)
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
	persist: () => Promise<result<void>>
	rollback: () => Promise<result<void>>
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
let pending_settlement: Promise<unknown> = Promise.resolve()
let pending_activation: Promise<void> = Promise.resolve()

function disconnect_activation_watcher() {
	const cleanup = activation_watcher_cleanup
	activation_watcher_cleanup = null
	cleanup?.()
}

async function run_activation(
	activate: (sequence: number) => Promise<result<void>>,
): Promise<result<void>> {
	const started = await attempt_async(begin_activation)
	if (!started.ok || started.value !== activation_sequence) return ok(undefined)
	const sequence = started.value
	const activated = flatten(await attempt_async(() => activate(sequence)))
	if (sequence !== activation_sequence) return ok(undefined)
	return activated
}

async function connect_access_point(
	ap: AstalNetwork.AccessPoint,
	sequence: number,
): Promise<result<void>> {
	const current = resolve_access_point(ap)
	if (!current) {
		set_authentication(idle_authentication)
		console.warn("network.connect: Wi-Fi access point is no longer available")
		return ok(undefined)
	}
	const saved = find_saved_access_point(current)
	if (is_personal_network(current) && !saved) {
		show_authentication(current)
		return ok(undefined)
	}
	return activate_and_watch(saved ?? current, null, sequence, false)
}

function forget_access_point(ap: AstalNetwork.AccessPoint) {
	const current = resolve_access_point(ap)
	const saved = current && find_saved_access_point(current)
	const connection = saved && find_saved_connection(saved)
	if (!connection) return
	void delete_connection(connection).then((result) =>
		log_error(result, "network.forget: Failed to forget Wi-Fi network"),
	)
}

function strongest_per_network(aps: AstalNetwork.AccessPoint[]) {
	const best = new Map<string, AstalNetwork.AccessPoint>()
	for (const ap of aps) {
		if (!ap.ssid) continue
		const known = best.get(ap.ssid)
		if (!known || ap.strength > known.strength) best.set(ap.ssid, ap)
	}
	return [...best.values()].sort((a, b) => b.strength - a.strength)
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
	if (transaction)
		log_error(
			await transaction.rollback(),
			"network.activate: Failed to cancel superseded Wi-Fi activation",
		)
	return sequence
}

function is_personal_network(ap: AstalNetwork.AccessPoint) {
	const personal =
		ap_security_flags.KEY_MGMT_PSK | ap_security_flags.KEY_MGMT_SAE
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
		if (candidate.ssid !== ap.ssid || !find_saved_connection(candidate))
			continue
		if (!best || candidate.strength > best.strength) best = candidate
	}

	return best
}

function fail_authentication() {
	set_authentication((state) => ({ ...state, phase: "failed" }))
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
			if (sequence === activation_sequence)
				set_authentication((state) => ({ ...state, shake: false }))
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
	app.get_window(authentication_window)?.show()
}

function is_credential_failure(
	ap: AstalNetwork.AccessPoint,
	state: AstalNetwork.DeviceState,
	reason: NM.DeviceStateReason,
) {
	if (!is_personal_network(ap)) return false
	if (reason === NM.DeviceStateReason.NO_SECRETS)
		return (
			state === AstalNetwork.DeviceState.NEED_AUTH ||
			state === AstalNetwork.DeviceState.FAILED
		)
	return (
		state === AstalNetwork.DeviceState.NEED_AUTH &&
		reason === NM.DeviceStateReason.SUPPLICANT_DISCONNECT
	)
}

function is_invalid_password_error(error: unknown) {
	return (
		error instanceof NM.ConnectionError &&
		error.code === NM.ConnectionError.INVALIDPROPERTY &&
		error.message.startsWith("802-11-wireless-security.psk:")
	)
}

type ready_callback = (_source: unknown, res: Gio.AsyncResult) => void

function flatten<T>(attempted: result<result<T>>): result<T> {
	if (!attempted.ok) return attempted
	return attempted.value
}

function settle_async<T>(
	start: (ready: ready_callback) => void,
	finish: (res: Gio.AsyncResult) => T,
): Promise<result<T>> {
	return new Promise((settle) => {
		const ready: ready_callback = (_source, res) =>
			settle(attempt(() => finish(res)))
		const started = attempt(() => start(ready))
		if (!started.ok) settle(started)
	})
}

function with_deadline<T>(
	ms: number,
	start: (cancellable: Gio.Cancellable, ready: ready_callback) => void,
	finish: (res: Gio.AsyncResult) => T,
): Promise<result<T>> {
	const cancellable = new Gio.Cancellable()
	const deadline = timeout(ms, () => cancellable.cancel())
	return settle_async(
		(ready) => start(cancellable, ready),
		(res) => {
			deadline.cancel()
			return finish(res)
		},
	)
}

function commit_connection(connection: NM.RemoteConnection) {
	return with_deadline<void>(
		10_000,
		(cancellable, ready) =>
			connection.commit_changes_async(true, cancellable, ready),
		(res) => connection.commit_changes_finish(res),
	)
}

function delete_connection(connection: NM.RemoteConnection) {
	return with_deadline<void>(
		10_000,
		(cancellable, ready) => connection.delete_async(cancellable, ready),
		(res) => connection.delete_finish(res),
	)
}

function deactivate_connection(active: NM.ActiveConnection) {
	return with_deadline<void>(
		10_000,
		(cancellable, ready) =>
			network.client.deactivate_connection_async(active, cancellable, ready),
		(res) => network.client.deactivate_connection_finish(res),
	)
}

async function activate_connection(
	connection: NM.Connection,
	ap: AstalNetwork.AccessPoint,
	cancellable: Gio.Cancellable,
): Promise<result<NM.ActiveConnection>> {
	const wifi = network.wifi
	if (!wifi) return err(new Error("No Wi-Fi device available"))

	return settle_async(
		(ready) =>
			network.client.activate_connection_async(
				connection,
				wifi.device,
				ap.get_path(),
				cancellable,
				ready,
			),
		(res) => network.client.activate_connection_finish(res),
	)
}

async function add_and_activate_connection(
	connection: NM.Connection | null,
	ap: AstalNetwork.AccessPoint,
	cancellable: Gio.Cancellable,
	volatile = false,
): Promise<result<NM.ActiveConnection>> {
	const wifi = network.wifi
	if (!wifi) return err(new Error("No Wi-Fi device available"))

	return settle_async(
		(ready) => {
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
				ready,
			)
		},
		(res) => network.client.add_and_activate_connection2_finish(res)[0],
	)
}

async function deactivate_and_delete(
	active: NM.ActiveConnection,
	connection: NM.RemoteConnection,
): Promise<result<void>> {
	const deactivated = await deactivate_connection(active)
	const deleted = await delete_connection(connection)
	if (!deleted.ok) return deleted
	return deactivated
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

async function nothing_to_persist(): Promise<result<void>> {
	return ok(undefined)
}

async function save_password(
	connection: NM.RemoteConnection,
	security: NM.SettingWirelessSecurity,
	password: string,
): Promise<result<void>> {
	const old_password = security.get_psk()
	security.set_property("psk", password)
	const committed = await commit_connection(connection)
	if (!committed.ok) security.set_property("psk", old_password)
	return committed
}

async function activate_with_new_password(
	connection: NM.RemoteConnection,
	ap: AstalNetwork.AccessPoint,
	password: string,
	cancellable: Gio.Cancellable,
): Promise<result<activation_transaction>> {
	const candidate = NM.SimpleConnection.new_clone(connection)
	const candidate_settings = candidate.get_setting_connection()
	const candidate_security = candidate.get_setting_wireless_security()
	const saved_security = connection.get_setting_wireless_security()
	if (!candidate_settings || !candidate_security || !saved_security)
		return err(new Error("Saved Wi-Fi connection has incomplete settings"))

	candidate_settings.set_property("uuid", GLib.uuid_string_random())
	candidate_security.set_property("psk", password)
	const activated = await add_and_activate_connection(
		candidate,
		ap,
		cancellable,
		true,
	)
	if (!activated.ok) return activated

	const active = activated.value
	const temporary = active.get_connection()
	return ok({
		active,
		persist: () => save_password(connection, saved_security, password),
		rollback: () => deactivate_and_delete(active, temporary),
	})
}

async function activate_saved(
	connection: NM.RemoteConnection,
	ap: AstalNetwork.AccessPoint,
	cancellable: Gio.Cancellable,
): Promise<result<activation_transaction>> {
	const activated = await activate_connection(connection, ap, cancellable)
	if (!activated.ok) return activated

	const active = activated.value
	return ok({
		active,
		persist: nothing_to_persist,
		rollback: () => deactivate_connection(active),
	})
}

async function activate_personal(
	ap: AstalNetwork.AccessPoint,
	password: string,
	cancellable: Gio.Cancellable,
): Promise<result<activation_transaction>> {
	const activated = await add_and_activate_connection(
		create_personal_connection(ap, password),
		ap,
		cancellable,
		true,
	)
	if (!activated.ok) return activated

	const active = activated.value
	const created = active.get_connection()
	return ok({
		active,
		persist: () => commit_connection(created),
		rollback: () => deactivate_and_delete(active, created),
	})
}

async function activate_open(
	ap: AstalNetwork.AccessPoint,
	cancellable: Gio.Cancellable,
): Promise<result<activation_transaction>> {
	const activated = await add_and_activate_connection(null, ap, cancellable)
	if (!activated.ok) return activated

	const active = activated.value
	const created = active.get_connection()
	return ok({
		active,
		persist: nothing_to_persist,
		rollback: () => deactivate_and_delete(active, created),
	})
}

async function activate_access_point(
	ap: AstalNetwork.AccessPoint,
	password: string | null,
	cancellable: Gio.Cancellable,
): Promise<result<activation_transaction>> {
	const current = resolve_access_point(ap)
	if (!current)
		return err(new Error("Wi-Fi access point is no longer available"))

	const connection = find_saved_connection(current)
	if (connection && password)
		return activate_with_new_password(
			connection,
			current,
			password,
			cancellable,
		)
	if (connection) return activate_saved(connection, current, cancellable)
	if (!is_personal_network(current)) return activate_open(current, cancellable)
	if (!password)
		return err(new Error("A password is required for this Wi-Fi network"))
	return activate_personal(current, password, cancellable)
}

async function start_activation(
	ap: AstalNetwork.AccessPoint,
	password: string | null,
	cancellable: Gio.Cancellable,
	sequence: number,
	authentication_open: boolean,
): Promise<result<void>> {
	const activated = await activate_access_point(ap, password, cancellable)
	if (!activated.ok) return activated

	const transaction = activated.value
	if (sequence !== activation_sequence) return transaction.rollback()
	watch_activation(ap, sequence, authentication_open, transaction)
	return ok(undefined)
}

async function activate_and_watch(
	ap: AstalNetwork.AccessPoint,
	password: string | null,
	sequence: number,
	authentication_open: boolean,
): Promise<result<void>> {
	const cancellable = activation_cancellable
	if (!cancellable) return ok(undefined)

	const deadline = timeout(25_000, () => cancellable.cancel())
	const activation = start_activation(
		ap,
		password,
		cancellable,
		sequence,
		authentication_open,
	).finally(() => deadline.cancel())
	pending_activation = settled(activation)
	return activation
}

async function settled(promise: Promise<unknown>) {
	await attempt_async(() => promise)
}

function settle_transaction(
	transaction: activation_transaction,
	persist: boolean,
): Promise<result<void>> {
	return guard_async(() => settle_steps(transaction, persist))
}

async function settle_steps(
	transaction: activation_transaction,
	persist: boolean,
): Promise<result<void>> {
	if (!persist) return transaction.rollback()

	const persisted = await transaction.persist()
	if (persisted.ok) return persisted

	log_error(
		await transaction.rollback(),
		"network.activate: Failed to cancel unsaved Wi-Fi connection",
	)
	return persisted
}

function finish_authentication(
	succeeded: boolean,
	authentication_open: boolean,
) {
	if (succeeded) {
		if (authentication_open) app.get_window(authentication_window)?.hide()
		set_authentication(idle_authentication)
		return
	}
	if (authentication_open) fail_authentication()
	else set_authentication(idle_authentication)
}

function abandon_activation(
	transaction: activation_transaction,
	sequence: number,
	authentication_open: boolean,
) {
	pending_settlement = guard_async(() => transaction.rollback()).then(
		(result) => {
			log_error(result, "network.activate: Failed to cancel Wi-Fi activation")
			if (sequence === activation_sequence && authentication_open)
				fail_authentication()
		},
	)
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
		abandon_activation(transaction, sequence, authentication_open)
		return
	}
	pending_transaction = transaction
	const settle = async (persist: boolean) => {
		if (pending_transaction === transaction) pending_transaction = null
		const settlement = settle_transaction(transaction, persist)
		pending_settlement = settlement
		const result = await settlement
		pending_settlement = Promise.resolve()
		return log_error(
			result,
			`network.settle: Failed to ${persist ? "save" : "restore"} Wi-Fi connection`,
		)
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
		const activated =
			state === AstalNetwork.DeviceState.ACTIVATED &&
			active_connection?.get_path() === transaction.active.get_path()
		if (activated && !is_active_network(wifi, ap)) return
		if (!activated && state !== AstalNetwork.DeviceState.FAILED) return

		disconnect_activation_watcher()
		const saved = await settle(activated)
		if (sequence !== activation_sequence) return
		finish_authentication(activated && saved, authentication_open)
	}
	const fail = () =>
		void update(AstalNetwork.DeviceState.FAILED, NM.DeviceStateReason.UNKNOWN)

	const state_changed_id = wifi.connect(
		"state-changed",
		(_source_wifi, new_state, _old_state, reason) => {
			void update(new_state, reason)
		},
	)
	const enabled_id = wifi.connect("notify::enabled", () => {
		if (!wifi.enabled) fail()
	})
	const wifi_id = network.connect("notify::wifi", () => {
		if (network.wifi !== wifi) fail()
	})
	const deadline = timeout(25_000, fail)
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
