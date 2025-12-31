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
		getActive: () => Accessor<string>,
		setActive: (p: string) => void,
		getProfiles: () => string[],
		icon: (p: string) => string,
		label: (p: string) => string,
		extraSettings?: () => Node,
		toggleDefaults: () => [string, string]
	}

	const asusProvider: Provider = {
		getActive: () => createBinding(asusctl, "profile"),
		// @ts-ignore: Valid keys
		setActive: (p: Asusctl.Profile) => { asusctl.profile = p },
		getProfiles: () => asusctl.profiles,
		// @ts-ignore: Valid keys
		icon: (p) => icons.asusctl.profile[p] || icons.missing,
		label: (p) => p,
		extraSettings: () => <Settings callback={() => launchApp("rog-control-center")} />,
		toggleDefaults: () => ["Quiet", "Balanced"],
	}

	const getPowerProvider = (): Provider | undefined => {
		try {
			if (!pp?.get_version?.()) return undefined
			return {
				getActive: () => createBinding(pp, "activeProfile"),
				getProfiles: () => pp?.get_profiles?.()?.map(p => p.profile) || [],
				setActive: (p) => pp?.set_active_profile?.(p),
				// @ts-ignore: Valid keys
				icon: (p) => icons.powerprofile[p] || icons.missing,
				label: (p) => prettify(p),
				toggleDefaults: () => {
					const profiles = pp.get_profiles()
					if (profiles.length >= 2) {
						return [profiles[0].profile, profiles[1].profile]
					}
					return ["power-saver", "balanced"]
				},
			}
		} catch {
			return undefined
		}
	}

	function makeToggle(provider: Provider) {
		const active = provider.getActive()
		const [on, off] = provider.toggleDefaults()
		return (
			<ArrowToggleButton
				name="profile-selector"
				iconName={active.as(p => provider.icon(p))}
				label={active.as(p => provider.label(p))}
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
			<Menu name="profile-selector" iconName={active.as(p => provider.icon(p))} title="Profiles">
				<box orientation={VERTICAL} hexpand>
					{profiles.map(p => (
						<button onClicked={() => provider.setActive(p)}>
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

	const getProvider = (): Provider | undefined => {
		if (asusctl.available) return asusProvider
		return getPowerProvider()
	}

	const provider = getProvider()

	export namespace State {
		export function Power() {
			if (!provider) return <box visible={false} />

			try {
				const active = provider.getActive()
				const [, off] = provider.toggleDefaults()
				const icon = active.as(p => provider.icon(p))
				const visible = active.as(p => p !== off)
				return <image iconName={icon} visible={visible} useFallback />
			} catch {
				return <box visible={false} />
			}
		}

		export function Asus() {
			if (!asusctl.available) return <box visible={false} />

			try {
				const mode = createBinding(asusctl, "mode")
				return (
					<image
						// @ts-ignore: Valid keys
						iconName={mode.as(m => icons.asusctl.mode[m])}
						visible={mode.as(m => m !== "Hybrid")}
						useFallback
					/>
				)
			} catch {
				return <box visible={false} />
			}
		}
	}

	export const Toggle = provider ? () => makeToggle(provider) : MissingToggle
	export const Selector = provider ? () => makeSelector(provider) : MissingSelector
}
