import { timeout, writeFile } from "astal"

import { sh, dependencies } from "./utils"
import { wp } from "./services"
import { env } from "./environment"
import options from "../options"

export default function init() {
	wp.connect("notify::wallpaper", () => matugen())
	options.autotheme.subscribe(() => matugen())
}

function animate(...setters: Array<() => void>) {
	const delay = options.transition.get() / 2
	setters.forEach((fn, i) => timeout(delay * i, fn))
}

function updateGtkTheme(colors: { light: Colors; dark: Colors }) {
	const generateColorDefinitions = () => ({
		gtk3: `
      @define-color accent_color ${colors.dark.primary_fixed_dim};
      @define-color accent_fg_color ${colors.dark.on_primary_fixed};
      @define-color accent_bg_color ${colors.dark.primary_fixed_dim};
      @define-color window_bg_color ${colors.dark.surface_dim};
      @define-color window_fg_color ${colors.dark.on_surface};
      @define-color headerbar_bg_color ${colors.dark.surface_dim};
      @define-color headerbar_fg_color ${colors.dark.on_surface};
      @define-color popover_bg_color ${colors.dark.surface_dim};
      @define-color popover_fg_color ${colors.dark.on_surface};
      @define-color view_bg_color ${colors.dark.surface};
      @define-color view_fg_color ${colors.dark.on_surface};
      @define-color card_bg_color ${colors.dark.surface};
      @define-color card_fg_color ${colors.dark.on_surface};
      @define-color sidebar_bg_color @window_bg_color;
      @define-color sidebar_fg_color @window_fg_color;
      @define-color sidebar_border_color @window_bg_color;
      @define-color sidebar_backdrop_color @window_bg_color;
    `,
		gtk4: `
		//   :root {
		// 		 --accent-blue: #3584e4;
		// 		 --accent-teal: #2190a4;
		// 		 --accent-green: #3a944a;
		// 		 --accent-yellow: #c88800;
		// 		 --accent-orange: #ed5b00;
		// 		 --accent-red: #e62d42;
		// 		 --accent-pink: #d56199;
		// 		 --accent-purple: #9141ac;
		// 		 --accent-slate: #6f8396;
		//
		//        --accent-bg-color: ${colors.light.primary_fixed_dim};
		//        --accent-fg-color: ${colors.light.on_primary_fixed};
		//
		//        --destructive-bg-color: ${colors.light.error};
		//        --destructive-fg-color: ${colors.light.on_error};
		//
		//        --success-bg-color: ${colors.light.primary};
		//        --success-fg-color: ${colors.light.on_primary};
		//
		//        --warning-bg-color: ${colors.light.surface_container_high};
		//        --warning-fg-color: ${colors.light.on_surface};
		//
		//        --error-bg-color: ${colors.light.error_container};
		//        --error-fg-color: ${colors.light.on_error_container};
		//
		//        --window-bg-color: ${colors.light.surface};
		//        --window-fg-color: ${colors.light.on_surface};
		//
		//        --view-bg-color: ${colors.light.surface};
		//        --view-fg-color: ${colors.light.on_surface};
		//
		//        --headerbar-bg-color: ${colors.light.surface_container};
		//        --headerbar-fg-color: ${colors.light.on_surface};
		//        // --headerbar-border-color: ${colors.light.outline_variant};
		//        --headerbar-backdrop-color: ${colors.light.surface_container_low};
		//        --headerbar-shade-color: ${colors.light.surface_container_lowest};
		//        --headerbar-darker-shade-color: ${colors.light.scrim};
		//
		//        --sidebar-bg-color: ${colors.light.surface_container};
		//        --sidebar-fg-color: ${colors.light.on_surface};
		//        --sidebar-backdrop-color: ${colors.light.surface_container_low};
		//        // --sidebar-border-color: ${colors.light.outline_variant};
		//        --sidebar-shade-color: ${colors.light.surface_container_lowest};
		//
		//        --secondary-sidebar-bg-color: ${colors.light.surface_container_low};
		//        --secondary-sidebar-fg-color: ${colors.light.on_surface_variant};
		//        --secondary-sidebar-backdrop-color: ${colors.light.surface_container_low};
		//        // --secondary-sidebar-border-color: ${colors.light.outline};
		//        --secondary-sidebar-shade-color: ${colors.light.surface_variant};
		//
		//        --card-bg-color: ${colors.light.surface_container_high};
		//        --card-fg-color: ${colors.light.on_surface};
		//        --card-shade-color: ${colors.light.surface_dim};
		//
		//        --dialog-bg-color: ${colors.light.surface_container_high};
		//        --dialog-fg-color: ${colors.light.on_surface};
		//
		//        --popover-bg-color: ${colors.light.surface_container};
		//        --popover-fg-color: ${colors.light.on_surface};
		//        --popover-shade-color: ${colors.light.surface_variant};
		//
		//        --thumbnail-bg-color: ${colors.light.surface};
		//        --thumbnail-fg-color: ${colors.light.on_surface};
		//
		//        --shade-color: ${colors.light.surface_container_low};
		//        --scrollbar-outline-color: ${colors.light.outline};
		// };

    :root {
				 --accent-blue: #3584e4;
				 --accent-teal: #2190a4;
				 --accent-green: #3a944a;
				 --accent-yellow: #c88800;
				 --accent-orange: #ed5b00;
				 --accent-red: #e62d42;
				 --accent-pink: #d56199;
				 --accent-purple: #9141ac;
				 --accent-slate: #6f8396;

         --accent-bg-color: ${colors.dark.primary_fixed_dim};
         --accent-fg-color: ${colors.dark.on_primary_fixed};

         --destructive-bg-color: ${colors.dark.error};
         --destructive-fg-color: ${colors.dark.on_error};

         --success-bg-color: ${colors.dark.primary};
         --success-fg-color: ${colors.dark.on_primary};

         --warning-bg-color: ${colors.dark.surface_container_high};
         --warning-fg-color: ${colors.dark.on_surface};

         --error-bg-color: ${colors.dark.error_container};
         --error-fg-color: ${colors.dark.on_error_container};

         --window-bg-color: ${colors.dark.surface};
         --window-fg-color: ${colors.dark.on_surface};

         --view-bg-color: ${colors.dark.surface};
         --view-fg-color: ${colors.dark.on_surface};

         --headerbar-bg-color: ${colors.dark.surface_container};
         --headerbar-fg-color: ${colors.dark.on_surface};
         // --headerbar-border-color: ${colors.dark.outline_variant};
         --headerbar-backdrop-color: ${colors.dark.surface_container_low};
         --headerbar-shade-color: ${colors.dark.surface_container_lowest};
         --headerbar-darker-shade-color: ${colors.dark.scrim};

         --sidebar-bg-color: ${colors.dark.surface_container};
         --sidebar-fg-color: ${colors.dark.on_surface};
         --sidebar-backdrop-color: ${colors.dark.surface_container_low};
         // --sidebar-border-color: ${colors.dark.outline_variant};
         --sidebar-shade-color: ${colors.dark.surface_container_lowest};

         --secondary-sidebar-bg-color: ${colors.dark.surface_container_low};
         --secondary-sidebar-fg-color: ${colors.dark.on_surface_variant};
         --secondary-sidebar-backdrop-color: ${colors.dark.surface_container_low};
         // --secondary-sidebar-border-color: ${colors.dark.outline};
         --secondary-sidebar-shade-color: ${colors.dark.surface_variant};

         --card-bg-color: ${colors.dark.surface_container_high};
         --card-fg-color: ${colors.dark.on_surface};
         --card-shade-color: ${colors.dark.surface_dim};

         --dialog-bg-color: ${colors.dark.surface_container_high};
         --dialog-fg-color: ${colors.dark.on_surface};

         --popover-bg-color: ${colors.dark.surface_container};
         --popover-fg-color: ${colors.dark.on_surface};
         --popover-shade-color: ${colors.dark.surface_variant};

         --thumbnail-bg-color: ${colors.dark.surface};
         --thumbnail-fg-color: ${colors.dark.on_surface};

         --shade-color: ${colors.dark.surface_container_low};
         --scrollbar-outline-color: ${colors.dark.outline};
		};
  `
	});

	const gtk3ThemePath = `${env.paths.home}/.config/gtk-3.0`;
	const gtk4ThemePath = `${env.paths.home}/.config/gtk-4.0`;

	const color = generateColorDefinitions()
	const writeThemeFiles = () => {
		writeFile(`${gtk3ThemePath}/gtk.css`, color.gtk3);
		writeFile(`${gtk4ThemePath}/gtk.css`, color.gtk4);
	};

	writeThemeFiles();
}

export async function matugen(
	type: "image" | "color" = "image",
	arg = wp.wallpaper,
) {
	if (!options.autotheme.get() || !dependencies("matugen"))
		return

	const colors = await sh(`matugen --dry-run -j hex ${type} ${arg}`)
	const c = JSON.parse(colors).colors as { light: Colors, dark: Colors }
	const { dark, light } = options.theme

	animate(
		() => {
			dark.widget.set(c.dark.on_surface)
			light.widget.set(c.light.on_surface)
		},
		() => {
			dark.border.set(c.dark.outline)
			light.border.set(c.light.outline)
		},
		() => {
			dark.bg.set(c.dark.surface)
			light.bg.set(c.light.surface)
		},
		() => {
			dark.fg.set(c.dark.on_surface)
			light.fg.set(c.light.on_surface)
		},
		() => {
			dark.primary.bg.set(c.dark.primary)
			light.primary.bg.set(c.light.primary)
		},
		() => {
			dark.primary.fg.set(c.dark.on_primary)
			light.primary.fg.set(c.light.on_primary)
		},
		() => {
			dark.error.bg.set(c.dark.error)
			light.error.bg.set(c.light.error)
		},
		() => {
			dark.error.fg.set(c.dark.on_error)
			light.error.fg.set(c.light.on_error)
		},
	)
	updateGtkTheme(c)
}

type Colors = {
	background: string
	error: string
	error_container: string
	inverse_on_surface: string
	inverse_primary: string
	inverse_surface: string
	on_background: string
	on_error: string
	on_error_container: string
	on_primary: string
	on_primary_container: string
	on_primary_fixed: string
	on_primary_fixed_variant: string
	on_secondary: string
	on_secondary_container: string
	on_secondary_fixed: string
	on_secondary_fixed_variant: string
	on_surface: string
	on_surface_variant: string
	on_tertiary: string
	on_tertiary_container: string
	on_tertiary_fixed: string
	on_tertiary_fixed_variant: string
	outline: string
	outline_variant: string
	primary: string
	primary_container: string
	primary_fixed: string
	primary_fixed_dim: string
	scrim: string
	secondary: string
	secondary_container: string
	secondary_fixed: string
	secondary_fixed_dim: string
	shadow: string
	surface: string
	surface_bright: string
	surface_container: string
	surface_container_high: string
	surface_container_highest: string
	surface_container_low: string
	surface_container_lowest: string
	surface_dim: string
	surface_variant: string
	tertiary: string
	tertiary_container: string
	tertiary_fixed: string
	tertiary_fixed_dim: string
}
