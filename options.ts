import { mkOptions } from "$lib/option"
import icons from "$lib/icons"
import { icon } from "$lib/utils"
import env from "$lib/env"

const options = mkOptions({
	autotheme: false,

	scale: 100,

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
		scheme: "dark",
		shadows: true,
		blur: true,
		neumorphic: true,
		opacity: 30,
		widget: {
			opacity: 94,
		},
		border: {
			width: 1,
			opacity: 86,
		},
		padding: 8,
		spacing: 6,
		roundness: 12,
		exportGtk: false,
	},

	transition: {
		duration: 200,
	},

	font: "SFProDisplay Nerd Font 11",

	bar: {
		position: "top-center",
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
				"spotify",
			],
		},
		media: {
			preferred: "spotify",
		},
	},

	taskbar: {
		location: "bar",
	},

	desktop: {
		enabled: true,
		iconSize: "medium",
	},

	dock: {
		mode: "static",
		trash: true,
		position: "bottom-center",
		scale: 100,
	},

	favorites: {
		location: "both",
	},

	launcher: {
		margin: 40,
		position: "top-center",
		apps: {
			max: 6,
		},
	},

	overview: {
		scale: 100,
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
		position: "top-right",
	},

	batterystate: {
		position: "top-right",
	},

	datemenu: {
		position: "center",
	},

	colorpicker: {
		maxColors: 10,
	},

	osd: {
		position: "bottom-center",
	},

	notifications: {
		position: "top-right",
		blacklist: ["Spotify", "com.spotify.Client"],
		dismiss: 3500,
	},

	hyprland: {
		gaps: 2.4,
		inactiveBorder: "#282828",
	},
})

export default options
