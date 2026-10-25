import app from "$lib/app"
import { Gtk } from "ags/gtk4"
import {
	Accessor,
	Node,
	With,
	createBinding,
	createComputed,
	createState,
	onCleanup,
} from "ags"

import AstalPowerProfiles from "gi://AstalPowerProfiles"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import {
	ToggleButton,
	Menu,
	SettingsButton,
} from "widget/Bar/components/QuickSettings/components/MenuControls"
import { Placeholder } from "widget/shared/Placeholder"
import icons from "$lib/icons"
import { attempt, log_error, unwrap_or } from "$lib/result"
import { launch_program } from "$lib/apps"
import { notify_missing_programs } from "$lib/notifications"
import { asusctl } from "$service/asusctl"
import { sleep_inhibitor } from "$service/sleep_inhibitor"
import { on_window_toggle } from "$lib/windowing"

export namespace PowerProfiles {
	export namespace State {
		export function Power() {
			return (
				<With value={provider}>
					{(current) => {
						if (!current) return <box visible={false} />
						const active = current.active
						const [, off] = current.toggle_defaults()
						const icon = active.as((profile) => current.icon(profile))
						const visible = active.as((profile) => profile !== off)
						return <image iconName={icon} visible={visible} useFallback />
					}}
				</With>
			)
		}

		export function Asus() {
			const mode = createBinding(asusctl, "mode")
			const mode_icon = mode.as((m) => get_mapped_icon(icons.asusctl.mode, m))
			return (
				<image
					iconName={mode_icon}
					visible={createComputed(
						() => asus_available() && mode() !== "Hybrid",
					)}
					useFallback
				/>
			)
		}
	}

	export function Toggle() {
		return (
			<With value={provider}>
				{(current) => (current ? make_toggle(current) : <MissingToggle />)}
			</With>
		)
	}

	export function Selector() {
		const unsubscribe = on_window_toggle("quicksettings", (window) => {
			if (window.visible && GLib.find_program_in_path("asusctl") !== null)
				void asusctl
					.refresh()
					.then((result) => log_error(result, "power_profiles.refresh:"))
		})
		onCleanup(unsubscribe)
		return (
			<With value={provider}>
				{(current) => (current ? make_selector(current) : <MissingSelector />)}
			</With>
		)
	}

	type profile_provider = {
		active: Accessor<string>
		select: (profile: string) => void
		profiles: () => string[]
		icon: (p: string) => string
		label: (p: string) => string
		extra_settings?: () => Node
		toggle_defaults: () => [string, string]
	}

	function get_mapped_icon(map: Record<string, string>, key: string) {
		return map[key] || icons.missing
	}

	const asus_provider: profile_provider = {
		active: createBinding(asusctl, "profile"),
		select: (profile) =>
			void asusctl
				.set_profile(profile)
				.then((result) => log_error(result, "power_profiles.select:")),
		profiles: () => asusctl.profiles,
		icon: (p) => get_mapped_icon(icons.asusctl.profile, p),
		label: (p) => p,
		extra_settings: () => (
			<SettingsButton
				callback={() => {
					if (notify_missing_programs("rog-control-center"))
						void launch_program(["rog-control-center"]).then((result) =>
							log_error(result, "power_profiles: Could not open settings"),
						)
				}}
			/>
		),
		toggle_defaults: () => ["Quiet", "Balanced"],
	}

	function prettify(name: string) {
		return name
			.split("-")
			.map((word) => `${word.at(0)?.toUpperCase()}${word.slice(1)}`)
			.join(" ")
	}

	function preferred(available: string[], wanted: string, fallback: string) {
		return available.includes(wanted) ? wanted : fallback
	}

	function power_toggle_defaults(available: string[]): [string, string] {
		const off = preferred(available, "balanced", available[0] ?? "balanced")
		const other = available.find((profile) => profile !== off) ?? off
		return [preferred(available, "power-saver", other), off]
	}

	function daemon_provider(
		power_profiles: AstalPowerProfiles.PowerProfiles,
	): profile_provider {
		const profiles = () =>
			unwrap_or(
				attempt(() =>
					power_profiles.get_profiles().map((item) => item.profile),
				),
				[],
				"power_profiles.profiles:",
			)
		return {
			active: createBinding(power_profiles, "activeProfile"),
			profiles,
			select: (profile) => {
				log_error(
					attempt(() => power_profiles.set_active_profile(profile)),
					"power_profiles.select:",
				)
			},
			icon: (p) => get_mapped_icon(icons.powerprofile, p),
			label: prettify,
			toggle_defaults: () => power_toggle_defaults(profiles()),
		}
	}

	function get_power_provider(): profile_provider | undefined {
		const created = attempt(() => {
			const power_profiles = power_profile_service.peek()
			if (!power_profiles) return undefined
			if (!power_profiles.get_version()) return undefined
			return daemon_provider(power_profiles)
		})
		return unwrap_or(created, undefined, "power_profiles.provider:")
	}

	function make_toggle(provider: profile_provider) {
		const active = provider.active
		const [on, off] = provider.toggle_defaults()
		return (
			<ToggleButton
				arrow
				name="profile-selector"
				iconName={active.as((p) => provider.icon(p))}
				label={active.as((p) => provider.label(p))}
				onToggle={
					on === off
						? undefined
						: () => provider.select(active.peek() === off ? on : off)
				}
				connection={active.as((p) => p !== off)}
			/>
		)
	}

	function SleepInhibitToggle() {
		const { inhibited } = sleep_inhibitor
		return (
			<centerbox hexpand>
				<button
					$type="end"
					class={inhibited.as((on) => (on ? "active" : ""))}
					tooltipText={inhibited.as((on) =>
						on ? "Sleep inhibited" : "Inhibit sleep",
					)}
					onClicked={sleep_inhibitor.toggle}
				>
					<image
						iconName={inhibited.as((on) =>
							on ? icons.sleep_inhibit.on : icons.sleep_inhibit.off,
						)}
						useFallback
					/>
				</button>
			</centerbox>
		)
	}

	function make_selector(provider: profile_provider) {
		const active = provider.active
		const profiles = provider.profiles()
		return (
			<Menu
				name="profile-selector"
				iconName={active.as((p) => provider.icon(p))}
				title="Profiles"
				header_child={<SleepInhibitToggle />}
			>
				<box orientation={VERTICAL} hexpand>
					{profiles.map((p) => (
						<button onClicked={() => provider.select(p)}>
							<box class="profile-item horizontal">
								<image iconName={provider.icon(p)} />
								<label label={provider.label(p)} />
							</box>
						</button>
					))}
					{provider.extra_settings && (
						<box orientation={VERTICAL}>
							<Gtk.Separator />
							{provider.extra_settings()}
						</box>
					)}
				</box>
			</Menu>
		)
	}

	function MissingToggle() {
		return (
			<ToggleButton
				arrow
				name="missing-profile"
				iconName={icons.missing}
				label="No Provider"
			/>
		)
	}

	function MissingSelector() {
		return (
			<Menu
				name="missing-profile"
				iconName={icons.missing}
				title="Install asusctl or powerprofiles daemon"
			>
				<Placeholder
					iconName={icons.missing}
					label="No power profile provider found"
				/>
			</Menu>
		)
	}

	const asus_available = createBinding(asusctl, "available")
	const [power_profile_service, set_power_profile_service] =
		createState<AstalPowerProfiles.PowerProfiles | null>(null)
	const [power_revision, set_power_revision] = createState(0)
	let power_handlers: number[] = []

	function bump_power_revision() {
		set_power_revision((revision) => revision + 1)
	}

	function attach_power_profiles() {
		const created = attempt(() => new AstalPowerProfiles.PowerProfiles())
		if (!log_error(created, "power_profiles.connect:")) return
		const current = created.value
		const version = attempt(() => current.get_version())
		if (!log_error(version, "power_profiles.version:")) return
		power_handlers = [
			current.connect("notify::version", bump_power_revision),
			current.connect("notify::profiles", bump_power_revision),
		]
		set_power_profile_service(current)
	}

	function detach_power_profiles() {
		const current = power_profile_service.peek()
		if (current)
			for (const handler of power_handlers) current.disconnect(handler)
		power_handlers = []
		set_power_profile_service(null)
	}

	const watch = Gio.bus_watch_name(
		Gio.BusType.SYSTEM,
		"org.freedesktop.UPower.PowerProfiles",
		Gio.BusNameWatcherFlags.NONE,
		attach_power_profiles,
		detach_power_profiles,
	)
	app.connect("shutdown", () => Gio.bus_unwatch_name(watch))
	const provider = createComputed(() => {
		if (asus_available()) return asus_provider
		power_profile_service()
		power_revision()
		return get_power_provider()
	})

	const { VERTICAL } = Gtk.Orientation
}
