export const substitutes = {
	"transmission-gtk": "transmission",
	"blueberry.py": "blueberry",
	"Caprine": "facebook-messenger",
	"com.raggesilver.BlackBox-symbolic": "terminal-symbolic",
	"org.wezfurlong.wezterm-symbolic": "terminal-symbolic",
	"audio-headset-bluetooth": "audio-headphones-symbolic",
	"audio-card-analog-usb": "audio-speakers-symbolic",
	"audio-card-analog-pci": "audio-card-symbolic",
	"audio-card-analog": "audio-card-symbolic",
	"Playback": "sound-wave-alt-symbolic",
	"preferences-system": "emblem-system-symbolic",
	"com.github.Aylur.ags-symbolic": "controls-symbolic",
	"com.github.Aylur.ags": "controls-symbolic",
}

export function getIcon(name: string, fallback = "image-missing-symbolic"): string {
	return substitutes[name as keyof typeof substitutes] || name || fallback
}

export function getBrightnessIcon(percent: number, type: "screen" | "keyboard" = "screen"): string {
	const icons = type === "keyboard" ? iconList.brightness.keyboard : iconList.brightness.screen
	if (percent === 0) return icons.off
	if (percent < 0.4) return icons.low
	if (percent < 0.8) return icons.medium
	return icons.high
}

const iconList = {
	missing: "image-missing-symbolic",
	nix: {
		nix: "nix-snowflake-symbolic",
	},
	app: {
		terminal: "terminal-symbolic",
	},
	fallback: {
		executable: "application-x-executable",
		notification: "dialog-information-symbolic",
		video: "video-x-generic-symbolic",
		image: "image-x-generic-symbolic",
		audio: "audio-x-generic-symbolic",
	},
	ui: {
		close: "window-close-symbolic",
		projector: "display-projector-symbolic",
		colorpicker: "color-picker-symbolic",
		info: "info-symbolic",
		link: "external-link-symbolic",
		lock: "system-lock-screen-symbolic",
		menu: "open-menu-symbolic",
		refresh: "view-refresh-symbolic",
		search: "system-search-symbolic",
		settings: "emblem-system-symbolic",
		themes: "dark-mode-symbolic",
		tick: "object-select-symbolic",
		time: "hourglass-symbolic",
		minus: "minus-large-symbolic",
		toolbars: "toolbars-symbolic",
		warning: "dialog-warning-symbolic",
		avatar: "avatar-default-symbolic",
		eye: "view-reveal-symbolic",
		hidden: "view-conceal-symbolic",
		arrow: {
			right: "go-right-symbolic",
			left: "go-left-symbolic",
			down: "go-down-symbolic",
			up: "go-up-symbolic",
		},
	},
	audio: {
		type: {
			headset: "headphones-symbolic",
			speaker: "speakers-symbolic",
			card: "soundcard-symbolic",
		},
		mixer: "window-sound-source-symbolic",
		devices: "audio-headset-symbolic",
	},
	powerprofile: {
		balanced: "power-profile-balanced-symbolic",
		"power-saver": "power-profile-power-saver-symbolic",
		performance: "power-profile-performance-symbolic",
	},
	asusctl: {
		profile: {
			Balanced: "power-profile-balanced-symbolic",
			Quiet: "power-profile-power-saver-symbolic",
			Performance: "power-profile-performance-symbolic",
		},
		mode: {
			Integrated: "processor-symbolic",
			Hybrid: "controller-symbolic",
		},
	},
	wifi: {
		enabled: "network-wireless-symbolic",
		scanning: "network-wireless-no-route-symbolic",
		offline: "network-wireless-offline-symbolic",
	},
	bluetooth: {
		enabled: "bluetooth-active-symbolic",
		disabled: "bluetooth-disabled-symbolic",
	},
	brightness: {
		indicator: "display-brightness-symbolic",
		keyboard: {
			off: "keyboard-brightness-off-symbolic",
			low: "keyboard-brightness-low-symbolic",
			medium: "keyboard-brightness-medium-symbolic",
			high: "keyboard-brightness-high-symbolic",
		},
		screen: {
			off: "display-brightness-off-symbolic",
			low: "display-brightness-low-symbolic",
			medium: "display-brightness-medium-symbolic",
			high: "display-brightness-high-symbolic",
		},
	},
	powermenu: {
		sleep: "weather-clear-night-symbolic",
		reboot: "system-reboot-symbolic",
		logout: "system-log-out-symbolic",
		shutdown: "system-shutdown-symbolic",
	},
	recorder: {
		recording: "media-record-symbolic",
	},
	notifications: {
		noisy: "org.gnome.Settings-notifications-symbolic",
		silent: "notifications-disabled-symbolic",
		message: "chat-bubbles-symbolic",
	},
	trash: {
		full: "user-trash-full-symbolic",
		empty: "user-trash-symbolic",
	},
	mpris: {
		shuffle: "media-playlist-shuffle-symbolic",
		loop: {
			none: "media-playlist-repeat-symbolic",
			track: "media-playlist-repeat-song-symbolic",
			playlist: "media-playlist-repeat-symbolic",
		},
		playing: "media-playback-pause-symbolic",
		paused: "media-playback-start-symbolic",
		stopped: "media-playback-start-symbolic",
		prev: "media-skip-backward-symbolic",
		next: "media-skip-forward-symbolic",
	},
	system: {
		cpu: "org.gnome.SystemMonitor-symbolic",
		ram: "drive-harddisk-solidstate-symbolic",
		temp: "temperature-symbolic",
	},
	color: {
		dark: "dark-mode-symbolic",
		light: "display-brightness-symbolic",
	},
}

export default iconList
