import { sh, dependencies, getFileSize } from "$lib/utils"
import { wp } from "$lib/services"
import { timeout } from "ags/time"

import options from "options"

export namespace Matugen {
	let matugenDebounce: any = null

	type ColorValue = {
		light: string
		dark: string
		default: string
	}

	type Colors = {
		background: ColorValue
		error: ColorValue
		error_container: ColorValue
		inverse_on_surface: ColorValue
		inverse_primary: ColorValue
		inverse_surface: ColorValue
		on_background: ColorValue
		on_error: ColorValue
		on_error_container: ColorValue
		on_primary: ColorValue
		on_primary_container: ColorValue
		on_primary_fixed: ColorValue
		on_primary_fixed_variant: ColorValue
		on_secondary: ColorValue
		on_secondary_container: ColorValue
		on_secondary_fixed: ColorValue
		on_secondary_fixed_variant: ColorValue
		on_surface: ColorValue
		on_surface_variant: ColorValue
		on_tertiary: ColorValue
		on_tertiary_container: ColorValue
		on_tertiary_fixed: ColorValue
		on_tertiary_fixed_variant: ColorValue
		outline: ColorValue
		outline_variant: ColorValue
		primary: ColorValue
		primary_container: ColorValue
		primary_fixed: ColorValue
		primary_fixed_dim: ColorValue
		scrim: ColorValue
		secondary: ColorValue
		secondary_container: ColorValue
		secondary_fixed: ColorValue
		secondary_fixed_dim: ColorValue
		shadow: ColorValue
		surface: ColorValue
		surface_bright: ColorValue
		surface_container: ColorValue
		surface_container_high: ColorValue
		surface_container_highest: ColorValue
		surface_container_low: ColorValue
		surface_container_lowest: ColorValue
		surface_dim: ColorValue
		surface_variant: ColorValue
		tertiary: ColorValue
		tertiary_container: ColorValue
		tertiary_fixed: ColorValue
		tertiary_fixed_dim: ColorValue
	}

	export async function init() {
		wp.connect("notify::wallpaper", () => getColors())
		options.autotheme.subscribe(() => getColors())
	}

	export async function getColors(
		type: "image" | "color" = "image",
		arg = wp.get_wallpaper(),
	) {
		if (!options.autotheme.get() || !dependencies("matugen") || !getFileSize(arg))
			return

		if (matugenDebounce) matugenDebounce.cancel()

		matugenDebounce = timeout(300, async () => {
			try {
				const colors = await sh(`matugen --dry-run -j hex ${type} ${arg}`)
				const c = JSON.parse(colors).colors as Colors
				const { dark, light } = options.theme

				const updates = [
					() => { dark.widget.set(c.on_surface.dark); light.widget.set(c.on_surface.light) },
					() => { dark.border.set(c.outline.dark); light.border.set(c.outline.light) },
					() => { dark.bg.set(c.surface.dark); light.bg.set(c.surface.light) },
					() => { dark.fg.set(c.on_surface.dark); light.fg.set(c.on_surface.light) },
					() => { dark.primary.bg.set(c.primary.dark); light.primary.bg.set(c.primary.light) },
					() => { dark.primary.fg.set(c.on_primary.dark); light.primary.fg.set(c.on_primary.light) },
					() => { dark.error.bg.set(c.error.dark); light.error.bg.set(c.error.light) },
					() => { dark.error.fg.set(c.on_error.dark); light.error.fg.set(c.on_error.light) }
				]

				for (const update of updates) {
					update()
					await new Promise(resolve => setTimeout(resolve, 1))
				}
			} catch (error) {
				console.error("Matugen color generation failed:", error)
			} finally {
				matugenDebounce = null
			}
		})
	}
}
