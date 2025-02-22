import { opt, mkOptions } from "./lib/option"
import { env } from "./lib/environment"
import icons from "./lib/icons"
import { getFavoriteApps, icon } from "./lib/utils"

const options = mkOptions({
	autotheme: opt(true),
	theme: {
		dark: {
			primary: {
				bg: opt("#51a4e7"),
				fg: opt("#141414"),
			},
			error: {
				bg: opt("#e55f86"),
				fg: opt("#141414"),
			},
			bg: opt("#171717"),
			fg: opt("#eeeeee"),
			widget: opt("#eeeeee"),
			border: opt("#eeeeee"),
		},
		light: {
			primary: {
				bg: opt("#426ede"),
				fg: opt("#eeeeee"),
			},
			error: {
				bg: opt("#b13558"),
				fg: opt("#eeeeee"),
			},
			bg: opt("#fffffa"),
			fg: opt("#080808"),
			widget: opt("#080808"),
			border: opt("#080808"),
		},

		blur: opt(70),
		blurOnLight: opt(false),

		scheme: opt<"dark" | "light">("dark"),
		widget: { opacity: opt(94) },
		border: {
			width: opt(1),
			opacity: opt(86),
		},

		shadows: opt(true),
		padding: opt(8),
		spacing: opt(6),
		radius: opt(12),
	},

	transition: opt(200),

	font: {
		size: opt(11),
		name: opt("SFProDisplay Nerd Font"),
	},

	bar: {
		position: opt<"top" | "bottom">("top"),
		corners: opt(50),
		transparent: opt(false),
		launcher: {
			icon: {
				icon: opt(icon(env.distro.logo, icons.ui.search)),
			}
		},
		date: {
			format: opt("%a %b %-d %H:%M"),
		},
		battery: {
			low: opt(30),
		},
		workspaces: {
			count: opt(0),
		},
		taskbar: {
			exclusive: opt(false),
		},
		systray: {
			ignore: opt([
				"KDE Connect Indicator",
				"spotify-client",
				"spotify"
			]),
		},
		media: {
			preferred: opt("spotify"),
			direction: opt<"left" | "right">("right"),
		}
	},

	launcher: {
		margin: opt(40),
		apps: {
			max: opt(6),
			favorites: opt(getFavoriteApps()),
		},
	},

	overview: {
		scale: opt(9),
		workspaces: opt(7),
	},

	powermenu: {
		sleep: opt("systemctl suspend"),
		reboot: opt("systemctl reboot"),
		logout: opt("hyprctl dispatch exit"),
		shutdown: opt("shutdown now"),
		layout: opt<"line" | "box">("line"),
		labels: opt(true),
	},

	quicksettings: {
		width: opt(380),
		position: opt<"left" | "center" | "right">("right"),
	},

	batterystate: {
		position: opt<"left" | "center" | "right">("right"),
	},

	datemenu: {
		position: opt<"left" | "center" | "right">("center"),
	},

	colorpicker: {
		maxColors: opt(10)
	},

	notifications: {
		position: opt<Array<"top" | "bottom" | "left" | "right">>(["top", "right"]),
		blacklist: opt(["Spotify", "com.spotify.Client"]),
		dismiss: opt(3500),
		width: opt(300),
	},

	hyprland: {
		gaps: opt(2.4),
		inactiveBorder: opt("#282828"),
	},
})

export default options

