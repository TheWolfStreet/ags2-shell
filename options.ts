// Lists the default settings that users can change and save.

import { mkOptions } from "$lib/option"
import icons, { resolveIcon } from "$lib/icons"
import env from "$lib/env"

export const optionValues = {
	themeScheme: ["dark", "light"],
	barPosition: ["top-center", "bottom-center"],
	taskbarLocation: ["bar", "dock"],
	dockMode: ["static", "autohide"],
	dockPosition: ["bottom-center", "center-left"],
	desktopIconSize: ["small", "medium", "large", "extralarge"],
	launcherPosition: ["top-center", "bottom-center"],
	favoritesLocation: ["disabled", "dock", "launcher", "both"],
	popupPosition: ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"],
	dateMenuPosition: ["center", "top-center", "bottom-center"],
	powerMenuLayout: ["box", "line"],
	osdPosition: ["center", "bottom-center"],
	refreshRate: [60, 144, 240],
} as const

const constraints = {
	"theme.scheme": optionValues.themeScheme,
	"bar.position": optionValues.barPosition,
	"taskbar.location": optionValues.taskbarLocation,
	"dock.mode": optionValues.dockMode,
	"dock.position": optionValues.dockPosition,
	"desktop.iconSize": optionValues.desktopIconSize,
	"launcher.position": optionValues.launcherPosition,
	"favorites.location": optionValues.favoritesLocation,
	"quicksettings.position": optionValues.popupPosition,
	"batterystate.position": optionValues.popupPosition,
	"datemenu.position": optionValues.dateMenuPosition,
	"powermenu.layout": optionValues.powerMenuLayout,
	"osd.position": optionValues.osdPosition,
	"notifications.position": optionValues.popupPosition,
	"asus.ac_hz": optionValues.refreshRate,
	"asus.bat_hz": optionValues.refreshRate,
} as const

const options = mkOptions({
	autotheme: false,
	scale: 100,
	font: "SFProDisplay Nerd Font 11",
	transition: {
		duration: 200,
	},

	theme: {
		scheme: "dark",
		dark: {
			bg: "#171717",
			fg: "#eeeeee",
			primary: {
				bg: "#51a4e7",
				fg: "#141414",
			},
			error: {
				bg: "#e55f86",
			},
			widget: "#eeeeee",
			border: "#9a9996",
		},
		light: {
			bg: "#fffffa",
			fg: "#080808",
			primary: {
				bg: "#426ede",
				fg: "#eeeeee",
			},
			error: {
				bg: "#b13558",
			},
			widget: "#080808",
			border: "#080808",
		},

		opacity: 30,
		widget: {
			opacity: 94,
		},
		border: {
			width: 1,
			opacity: 86,
		},
		shadows: true,
		blur: true,
		neumorphic: true,

		padding: 8,
		spacing: 6,
		roundness: 12,
	},

	bar: {
		position: "top-center",
		transparent: false,
		corners: 50,

		launcher: {
			icon: resolveIcon(env.distro.logo, icons.ui.search),
		},
		workspaces: {
			count: 7,
		},
		taskbar: {
			exclusive: false,
		},
		date: {
			format: "%a %b %-d %H:%M",
		},
		media: {
			preferred: "spotify",
		},
		systray: {
			ignore: [
				"KDE Connect Indicator",
				"spotify-client",
				"spotify",
			],
		},
	},

	taskbar: {
		location: "bar",
	},

	dock: {
		mode: "static",
		position: "bottom-center",
		scale: 100,
		trash: true,
	},

	desktop: {
		enabled: true,
		iconSize: "medium",
	},

	launcher: {
		position: "top-center",
		margin: 40,
		apps: {
			max: 6,
		},
	},

	favorites: {
		location: "both",
	},

	overview: {
		scale: 100,
		workspaces: 7,
	},

	quicksettings: {
		position: "top-right",
		width: 380,
	},

	batterystate: {
		position: "top-right",
	},

	datemenu: {
		position: "center",
	},

	powermenu: {
		layout: "line",
		labels: true,
		sleep: "systemctl suspend",
		reboot: "systemctl reboot",
		logout: "hyprctl dispatch exit",
		shutdown: "shutdown now",
	},

	osd: {
		position: "bottom-center",
	},

	notifications: {
		position: "top-right",
		blacklist: ["Spotify", "com.spotify.Client"],
		dismiss: 3500,
	},

	colorpicker: {
		maxColors: 10,
	},

	hyprland: {
		gaps: 2.4,
		inactiveBorder: "#282828",
	},

	asus: {
		resolution: "1920x1200",
		ac_hz: 144,
		bat_hz: 60,
	},
}, constraints)

export default options
