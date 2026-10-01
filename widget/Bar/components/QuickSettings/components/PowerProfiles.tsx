import app from "$lib/app"
import { Gtk } from "ags/gtk4"
import { Accessor, Node, With, createBinding, createComputed, createState, onCleanup } from "ags"

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
import { attempt } from "$lib/result"
import { launch_program } from "$lib/apps"
import { notify_missing_programs } from "$lib/notifications"
import { asusctl } from "$service/asusctl"
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
			const mode_icon = mode.as((m) =>
				get_mapped_icon(icons.asusctl.mode as icon_map, m),
			)
			return (
				<image
					iconName={mode_icon}
					visible={createComputed(() => asus_available() && mode() !== "Hybrid")}
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
				void asusctl.refresh().then((result) => {
					if (!result.ok) console.error("powerProfiles.refresh:", result.err)
				})
		})
		onCleanup(unsubscribe)
		return (
			<With value={provider}>
				{(current) => (current ? make_selector(current) : <MissingSelector />)}
			</With>
		)
	}

	type icon_map = Record<string, string | undefined>

	interface profile_provider {
		active: Accessor<string>
		select: (profile: string) => void
		profiles: () => string[]
		icon: (p: string) => string
		label: (p: string) => string
		extra_settings?: () => Node
		toggle_defaults: () => [string, string]
	}

	function get_mapped_icon(map: icon_map, key: string) {
		return map[key] || icons.missing
	}

	const asus_provider: profile_provider = {
		active: createBinding(asusctl, "profile"),
		select: (profile) => void asusctl.set_profile(profile).then((result) => {
			if (!result.ok) console.error("powerProfiles.select:", result.err)
		}),
		profiles: () => asusctl.profiles,
		icon: (p) => get_mapped_icon(icons.asusctl.profile as icon_map, p),
		label: (p) => p,
		extra_settings: () => (
			<SettingsButton callback={() => {
				if (notify_missing_programs("rog-control-center"))
					void launch_program(["rog-control-center"]).then(result => {
						if (!result.ok) console.error("powerProfiles: Could not open settings", result.err)
					})
			}} />
		),
		toggle_defaults: () => ["Quiet", "Balanced"],
	}

	function prettify(str: string) {
		return str
			.split("-")
			.map((str) => `${str.at(0)?.toUpperCase()}${str.slice(1)}`)
			.join(" ")
	}

	const get_power_provider = (): profile_provider | undefined => {
		const result = attempt((): profile_provider | undefined => {
			const power_profiles = power_profile_service.peek()
			if (!power_profiles) return undefined
			if (!power_profiles.get_version()) return undefined
			const profiles = () => {
				const available = attempt(() => power_profiles.get_profiles().map((item) => item.profile))
				if (!available.ok) console.error("powerProfiles.profiles:", available.err)
				return available.ok ? available.value : []
			}
			return {
				active: createBinding(power_profiles, "activeProfile"),
				profiles,
				select: (profile) => {
					const result = attempt(() => power_profiles.set_active_profile(profile))
					if (!result.ok) console.error("powerProfiles.select:", result.err)
				},
				icon: (p) => get_mapped_icon(icons.powerprofile as icon_map, p),
				label: (p) => prettify(p),
				toggle_defaults: () => {
					const available = profiles()
					const off = available.includes("balanced") ? "balanced" : available[0] ?? "balanced"
					const on = available.includes("power-saver") ? "power-saver" : available.find((profile) => profile !== off) ?? off
					return [on, off]
				},
			}
		})
		if (!result.ok) console.error("powerProfiles.provider:", result.err)
		return result.ok ? result.value : undefined
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
				onToggle={on === off ? undefined : () => provider.select(active.peek() === off ? on : off)}
				connection={active.as((p) => p !== off)}
			/>
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
	const [power_profile_service, set_power_profile_service] = createState<AstalPowerProfiles.PowerProfiles | null>(null)
	const [power_revision, set_power_revision] = createState(0)
	let power_handlers: number[] = []
	const watch = Gio.bus_watch_name(Gio.BusType.SYSTEM, "org.freedesktop.UPower.PowerProfiles", Gio.BusNameWatcherFlags.NONE,
		() => {
			const created = attempt(() => new AstalPowerProfiles.PowerProfiles())
			if (!created.ok) { console.error("powerProfiles.connect:", created.err); return }
			const current = created.value
			if (!attempt(() => current.get_version()).ok) return
			power_handlers = [
				current.connect("notify::version", () => set_power_revision((revision) => revision + 1)),
				current.connect("notify::profiles", () => set_power_revision((revision) => revision + 1)),
			]
			set_power_profile_service(current)
		},
		() => {
			const current = power_profile_service.peek()
			if (current) for (const handler of power_handlers) current.disconnect(handler)
			power_handlers = []
			set_power_profile_service(null)
		})
	app.connect("shutdown", () => Gio.bus_unwatch_name(watch))
	const provider = createComputed(() => {
		if (asus_available()) return asus_provider
		power_profile_service()
		power_revision()
		return get_power_provider()
	})

	const { VERTICAL } = Gtk.Orientation
}
