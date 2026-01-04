import { mkOptions } from "$lib/option"
import icons from "$lib/icons"
import { icon } from "$lib/utils"
import env from "$lib/env"

const options = mkOptions({
	autotheme: false,

	theme: {
		dark: {
			primary: {
				bg: "#51a4e7",
				fg: "#141414",
			},
			error: {
				bg: "#e55f86",
				fg: "#141414",
			},
			bg: "#171717",
			fg: "#eeeeee",
			widget: "#eeeeee",
			border: "#9a9996",
		},
		light: {
			primary: {
				bg: "#426ede",
				fg: "#eeeeee",
			},
			error: {
				bg: "#b13558",
				fg: "#eeeeee",
			},
			bg: "#fffffa",
			fg: "#080808",
			widget: "#080808",
			border: "#080808",
		},
		blur: 70,
		blurOnLight: false,
		scheme: "dark",
		widget: {
			opacity: 94,
		},
		border: {
			width: 1,
			opacity: 86,
		},
		shadows: true,
		padding: 8,
		spacing: 6,
		radius: 12,
	},

	transition: {
		duration: 200,
	},

	font: "SFProDisplay Nerd Font 11",

	bar: {
		position: "top",
		corners: 50,
		transparent: false,
		launcher: {
			icon: icon(env.distro.logo, icons.ui.search),
		},
		date: {
			format: "%a %b %-d %H:%M",
		},
		workspaces: {
			count: 7,
		},
		taskbar: {
			exclusive: false,
		},
		systray: {
			ignore: [
				"KDE Connect Indicator",
				"spotify-client",
				"spotify"
			],
		},
		media: {
			preferred: "spotify",
		},
	},

	launcher: {
		margin: 40,
		apps: {
			max: 6,
		},
	},

	overview: {
		scale: 9,
		workspaces: 7,
	},

	powermenu: {
		sleep: "systemctl suspend",
		reboot: "systemctl reboot",
		logout: "hyprctl dispatch exit",
		shutdown: "shutdown now",
		layout: "line",
		labels: true,
	},

	asus: {
		resolution: "1920x1200",
		ac_hz: 144,
		bat_hz: 60,
	},

	quicksettings: {
		width: 380,
		position: "right",
	},

	batterystate: {
		position: "right",
	},

	datemenu: {
		position: "center",
	},

	colorpicker: {
		maxColors: 10,
	},

	notifications: {
		position: ["top", "right"],
		blacklist: ["Spotify", "com.spotify.Client"],
		dismiss: 3500,
	},

	hyprland: {
		gaps: 2.4,
		inactiveBorder: "#282828",
	}
})
export default options
