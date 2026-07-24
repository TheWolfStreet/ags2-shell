// Lists available power profiles and applies the selected one.

import { Gtk } from "ags/gtk4"
import { Accessor, Node, With, createBinding, createComputed } from "ags"
import { ToggleButton, Menu, Settings } from "widget/Bar/components/QuickSettings/components/shared/MenuElements"
import { Placeholder } from "widget/shared/Placeholder"
import icons from "$lib/icons"
import { powerProfiles } from "$service/system"
import { attempt } from "$lib/result"
import { launchApp } from "$lib/programs"
import { asusctl } from "$service/asusctl"

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
			if (!powerProfiles?.get_version?.()) return undefined
			return {
				active: createBinding(powerProfiles, "activeProfile"),
				profiles: () => powerProfiles?.get_profiles?.()?.map(p => p.profile) || [],
				select: (profile) => powerProfiles?.set_active_profile?.(profile),
				icon: p => getMappedIcon(icons.powerprofile as IconMap, p),
				label: (p) => prettify(p),
				toggleDefaults: () => {
					const profiles = powerProfiles.get_profiles()
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
						<box orientation={VERTICAL}>
							<Gtk.Separator />
							{provider.extraSettings()}
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
			<Menu name="missing-profile" iconName={icons.missing} title="Install asusctl or powerprofiles daemon">
				<Placeholder iconName={icons.missing} label="No power profile provider found" />
			</Menu>
		)
	}

	const asusAvailable = createBinding(asusctl, "available")
	const provider = createComputed(() => asusAvailable() ? asusProvider : getPowerProvider())

	export namespace State {
		export function Power() {
			return (
				<With value={provider}>
					{current => {
						if (!current) return <box visible={false} />
						const result = attempt(() => {
							const active = current.active
							const [, off] = current.toggleDefaults()
							const icon = active.as(profile => current.icon(profile))
							const visible = active.as(profile => profile !== off)
							return <image iconName={icon} visible={visible} useFallback />
						})
						return result.ok ? result.value : <box visible={false} />
					}}
				</With>
			)
		}

		export function Asus() {
			const result = attempt(() => {
				const mode = createBinding(asusctl, "mode")
				const modeIcon = mode.as(m => getMappedIcon(icons.asusctl.mode as IconMap, m))
				return (
					<image
						iconName={modeIcon}
						visible={createComputed(() => asusAvailable() && mode() !== "Hybrid")}
						useFallback
					/>
				)
			})
			return result.ok ? result.value : <box visible={false} />
		}
	}

	export function Toggle() {
		return (
			<With value={provider}>
				{current => current ? makeToggle(current) : <MissingToggle />}
			</With>
		)
	}

	export function Selector() {
		return (
			<With value={provider}>
				{current => current ? makeSelector(current) : <MissingSelector />}
			</With>
		)
	}
}
