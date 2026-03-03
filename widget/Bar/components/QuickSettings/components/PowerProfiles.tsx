import { Gtk } from "ags/gtk4"
import { Accessor, Node, createBinding } from "ags"
import { ToggleButton, Menu, Settings } from "widget/Bar/components/QuickSettings/components/shared/MenuElements"
import { Placeholder } from "widget/shared/Placeholder"
import icons from "$lib/icons"
import { pp } from "$lib/services"
import { attempt } from "$lib/result"
import { launchApp } from "$lib/utils"
import { asusctl } from "$lib/services"

const { VERTICAL } = Gtk.Orientation

export namespace Profiles {
	type IconMap = Record<string, string | undefined>

	interface Provider {
		active: Accessor<string>
		select: (profile: string) => void
		profiles: () => string[]
		icon: (p: string) => string,
		label: (p: string) => string,
		extraSettings?: () => Node,
		toggleDefaults: () => [string, string]
	}

	function getMappedIcon(map: IconMap, key: string) {
		return map[key] || icons.missing
	}

	function isAsusProfile(value: string): value is "Performance" | "Balanced" | "Quiet" {
		return value === "Performance" || value === "Balanced" || value === "Quiet"
	}

	const asusProvider: Provider = {
		active: createBinding(asusctl, "profile"),
		select: p => {
			if (isAsusProfile(p)) {
				asusctl.profile = p
			}
		},
		profiles: () => asusctl.profiles,
		icon: p => getMappedIcon(icons.asusctl.profile as IconMap, p),
		label: (p) => p,
		extraSettings: () => <Settings callback={() => launchApp("rog-control-center")} />,
		toggleDefaults: () => ["Quiet", "Balanced"],
	}

	function prettify(str: string) {
		return str
			.split("-")
			.map((str) => `${str.at(0)?.toUpperCase()}${str.slice(1)}`)
			.join(" ")
	}

	const getPowerProvider = (): Provider | undefined => {
		const result = attempt((): Provider | undefined => {
			if (!pp?.get_version?.()) return undefined
			return {
				active: createBinding(pp, "activeProfile"),
				profiles: () => pp?.get_profiles?.()?.map(p => p.profile) || [],
				select: (profile) => pp?.set_active_profile?.(profile),
				icon: p => getMappedIcon(icons.powerprofile as IconMap, p),
				label: (p) => prettify(p),
				toggleDefaults: () => {
					const profiles = pp.get_profiles()
					if (profiles.length >= 2) {
						return [profiles[0].profile, profiles[1].profile]
					}
					return ["power-saver", "balanced"]
				},
			}
		})
		return result.ok ? result.value : undefined
	}

	function makeToggle(provider: Provider) {
		const active = provider.active
		const [on, off] = provider.toggleDefaults()
		return (
			<ToggleButton
				arrow
				name="profile-selector"
				iconName={active.as(p => provider.icon(p))}
				label={active.as(p => provider.label(p))}
				activate={() => provider.select(on)}
				deactivate={() => provider.select(off)}
				connection={active.as(p => p !== off)}
			/>
		)
	}

	function makeSelector(provider: Provider) {
		const active = provider.active
		const profiles = provider.profiles()
		return (
			<Menu name="profile-selector" iconName={active.as(p => provider.icon(p))} title="Profiles">
				<box orientation={VERTICAL} hexpand>
					{profiles.map(p => (
						<button onClicked={() => provider.select(p)}>
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
			<Menu name="missing-profile" iconName={icons.missing} title="Install asusctl or powerprofiles daemon">
				<Placeholder iconName={icons.missing} label="No power profile provider found" />
			</Menu>
		)
	}

	const getProvider = (): Provider | undefined => {
		if (asusctl.available) return asusProvider
		return getPowerProvider()
	}

	export namespace State {
		export function Power() {
			const provider = getProvider()
			if (!provider) return <box visible={false} />

			const result = attempt(() => {
				const active = provider.active
				const [, off] = provider.toggleDefaults()
				const icon = active.as(p => provider.icon(p))
				const visible = active.as(p => p !== off)
				return <image iconName={icon} visible={visible} useFallback />
			})
			return result.ok ? result.value : <box visible={false} />
		}

		export function Asus() {
			if (!asusctl.available) return <box visible={false} />

			const result = attempt(() => {
				const mode = createBinding(asusctl, "mode")
				const modeIcon = mode.as(m => getMappedIcon(icons.asusctl.mode as IconMap, m))
				return (
					<image
						iconName={modeIcon}
						visible={mode.as(m => m !== "Hybrid")}
						useFallback
					/>
				)
			})
			return result.ok ? result.value : <box visible={false} />
		}
	}

	export function Toggle() {
		const provider = getProvider()
		return provider ? makeToggle(provider) : <MissingToggle />
	}

	export function Selector() {
		const provider = getProvider()
		return provider ? makeSelector(provider) : <MissingSelector />
	}
}
