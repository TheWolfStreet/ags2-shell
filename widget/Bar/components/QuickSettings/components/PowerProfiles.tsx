import icons from "$lib/icons"
import { pp } from "$lib/services"
import { launchApp } from "$lib/utils"
import { asusctl } from "$lib/services"
import { Gtk } from "ags/gtk4"
import { Accessor, Node, createBinding } from "gnim"

import { ArrowToggleButton, Menu, Settings } from "widget/Bar/components/QuickSettings/components/shared/MenuElements"
import { Placeholder } from "widget/shared/Placeholder"

const { VERTICAL } = Gtk.Orientation

export namespace Profiles {
	function prettify(str: string) {
		return str
			.split("-")
			.map((str) => `${str.at(0)?.toUpperCase()}${str.slice(1)}`)
			.join(" ")
	}

	interface Provider {
		getActive: () => Accessor<string>,
		getProfiles: () => string[],
		setActive: (p: string) => void,
		iconFor: (p: string) => string,
		labelFor: (p: string) => string,
		extraSettings?: Node,
		toggleDefaults: () => [string, string]
	}

	const asusProvider: Provider = {
		getActive: () => createBinding(asusctl, "profile"),
		getProfiles: () => asusctl.profiles,
		// @ts-ignore: Valid keys
		setActive: (p: Asusctl.Profile) => { asusctl.profile = p },
		// @ts-ignore: Valid keys
		iconFor: (p) => icons.asusctl.profile[p],
		labelFor: (p) => p,
		extraSettings: <Settings callback={() => launchApp("rog-control-center")} />,
		toggleDefaults: () => ["Quiet", "Balanced"],
	}

	const powerProvider: Provider | undefined = pp?.version ? {
		getActive: () => createBinding(pp, "activeProfile"),
		getProfiles: () => pp.get_profiles().map(p => p.profile),
		setActive: (p) => pp.set_active_profile(p),
		// @ts-ignore: Valid keys
		iconFor: (p) => icons.powerprofile[p],
		labelFor: (p) => prettify(p),
		toggleDefaults: () => {
			const profiles = pp.get_profiles()
			if (profiles.length >= 2) {
				return [profiles[0].profile, profiles[1].profile]
			}
			return ["", ""]
		},
	} : undefined

	function makeToggle(provider: Provider) {
		const active = provider.getActive()
		const [on, off] = provider.toggleDefaults()

		return (
			<ArrowToggleButton
				name="profile-selector"
				iconName={active.as(p => provider.iconFor(p))}
				label={active.as(p => provider.labelFor(p))}
				activate={() => provider.setActive(on)}
				deactivate={() => provider.setActive(off)}
				connection={active.as(p => p !== off)}
			/>
		)
	}

	function makeSelector(provider: Provider) {
		const active = provider.getActive()
		const profiles = provider.getProfiles()
		return (
			<Menu name="profile-selector" iconName={active.as(p => provider.iconFor(p))} title="Profile Selector">
				<box orientation={VERTICAL} hexpand>
					{profiles.map(p => (
						<button onClicked={() => provider.setActive(p)}>
							<box class="profile-item horizontal">
								<image iconName={provider.iconFor(p)} />
								<label label={provider.labelFor(p)} />
							</box>
						</button>
					))}
					{provider.extraSettings && (
						<>
							<Gtk.Separator />
							{provider.extraSettings}
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
