import { Gtk } from "ags/gtk4"
import { Accessor, Node, createBinding } from "ags"

import { ArrowToggleButton, Menu, Settings } from "widget/Bar/components/QuickSettings/components/shared/MenuElements"
import { Placeholder } from "widget/shared/Placeholder"

import icons from "$lib/icons"
import { pp } from "$lib/services"
import { launchApp } from "$lib/utils"
import { asusctl } from "$lib/services"

const { VERTICAL } = Gtk.Orientation

export namespace Profiles {
	function prettify(str: string) {
		return str
			.split("-")
			.map((str) => `${str.at(0)?.toUpperCase()}${str.slice(1)}`)
			.join(" ")
	}

	interface Provider {
		get_active: () => Accessor<string>,
		get_profiles: () => string[],
		set_active: (p: string) => void,
		icon: (p: string) => string,
		label: (p: string) => string,
		extraSettings?: () => Node,
		toggleDefaults: () => [string, string]
	}

	const asusProvider: Provider = {
		get_active: () => createBinding(asusctl, "profile"),
		get_profiles: () => asusctl.profiles,
		// @ts-ignore: Valid keys
		set_active: (p: Asusctl.Profile) => { asusctl.profile = p },
		// @ts-ignore: Valid keys
		icon: (p) => icons.asusctl.profile[p],
		label: (p) => p,
		extraSettings: () => <Settings callback={() => launchApp("rog-control-center")} />,
		toggleDefaults: () => ["Quiet", "Balanced"],
	}

	const powerProvider: Provider | undefined = pp?.version ? {
		get_active: () => createBinding(pp, "activeProfile"),
		get_profiles: () => pp.get_profiles().map(p => p.profile),
		set_active: (p) => pp.set_active_profile(p),
		// @ts-ignore: Valid keys
		icon: (p) => icons.powerprofile[p],
		label: (p) => prettify(p),
		toggleDefaults: () => {
			const profiles = pp.get_profiles()
			if (profiles.length >= 2) {
				return [profiles[0].profile, profiles[1].profile]
			}
			return ["", ""]
		},
	} : undefined

	function makeToggle(provider: Provider) {
		const active = provider.get_active()
		const [on, off] = provider.toggleDefaults()

		return (
			<ArrowToggleButton
				name="profile-selector"
				iconName={active.as(p => provider.icon(p))}
				label={active.as(p => provider.label(p))}
				activate={() => provider.set_active(on)}
				deactivate={() => provider.set_active(off)}
				connection={active.as(p => p !== off)}
			/>
		)
	}

	function makeSelector(provider: Provider) {
		const active = provider.get_active()
		const profiles = provider.get_profiles()
		return (
			<Menu name="profile-selector" iconName={active.as(p => provider.icon(p))} title="Profiles">
				<box orientation={VERTICAL} hexpand>
					{profiles.map(p => (
						<button onClicked={() => provider.set_active(p)}>
							<box class="profile-item horizontal">
								<image iconName={provider.icon(p)} />
								<label label={provider.label(p)} />
							</box>
						</button>
					))}
					{provider.extraSettings && (
						<>
							<Gtk.Separator />
							{provider.extraSettings()}
						</>
					)}
				</box>
			</Menu>
		)
	}

	function MissingToggle() {
		return (
			<ArrowToggleButton
				name="missing-profile"
				iconName={icons.missing}
				label="No Provider"
			/>
		)
	}

	function MissingSelector() {
		return (
			<Menu name="missing-profile" iconName={icons.missing} title="Install asusctl or powerprofiles daemon">
				<Placeholder iconName={icons.missing} label="No power profile provider found" />
			</Menu>
		)
	}

	const provider = asusctl.available ? asusProvider : powerProvider

	export namespace State {
		export function Power() {
			const visible = asusctl.available
				? createBinding(asusctl, "profile").as(p => p !== "Balanced") : pp.get_version() ?
					createBinding(pp, "active_profile").as(p => p !== "balanced") : false

			const icon = asusctl.available
				// @ts-ignore: Valid keys
				? createBinding(asusctl, "profile").as((p: string) => icons.asusctl.profile[p])
				: pp.get_version() ? createBinding(pp, "active_profile").as((p: string) =>
					icons.powerprofile[p as "balanced" | "power-saver" | "performance"]) : ""

			return <image iconName={icon} visible={visible} useFallback />
		}

		export function Asus() {
			if (!asusctl.available) return <image visible={false} useFallback />
			const mode = createBinding(asusctl, "mode")
			return (
				<image
					// @ts-ignore: Valid keys
					iconName={mode.as(m => icons.asusctl.mode[m])}
					visible={mode.as(m => m !== "Hybrid")}
					useFallback
				/>
			)
		}
	}

	export const Toggle = provider ? () => makeToggle(provider) : MissingToggle
	export const Selector = provider ? () => makeSelector(provider) : MissingSelector
}
