// Lists icon names and finds fallback icons when one is missing.

import env from "$lib/env"

const substitutes = {
	"audio-headset-bluetooth": "audio-headphones-symbolic",
	"audio-card-analog-usb": "audio-speakers-symbolic",
	"audio-card-analog-pci": "audio-card-symbolic",
	"audio-card-analog": "audio-card-symbolic",
	"Playback": "sound-wave-alt-symbolic",
}

const iconList = {
	missing: "image-missing-symbolic",
	fallback: {
		notification: "dialog-information-symbolic",
		video: "video-x-generic-symbolic",
		image: "image-x-generic-symbolic",
	},
	ui: {
		close: "window-close-symbolic",
		projector: "display-projector-symbolic",
		colorpicker: "color-picker-symbolic",
		refresh: "view-refresh-symbolic",
		search: "system-search-symbolic",
		settings: "org.gnome.Settings-symbolic",
		themes: "dark-mode-symbolic",
		tick: "object-select-symbolic",
		toolbars: "toolbars-symbolic",
		eye: "view-reveal-symbolic",
		hidden: "view-conceal-symbolic",
		arrow: {
			right: "go-right-symbolic",
			left: "go-left-symbolic",
		},
	},
	audio: {
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
	trashDetailed: {
		full: "user-trash-full",
		empty: "user-trash",
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
		prev: "media-skip-backward-symbolic",
		next: "media-skip-forward-symbolic",
	},
	color: {
		dark: "dark-mode-symbolic",
		light: "display-brightness-symbolic",
	},
}

export function substituteIconName(name: string, fallback = "image-missing-symbolic"): string {
	return substitutes[name as keyof typeof substitutes] || name || fallback
}

export function resolveIcon(name?: string, fallback = iconList.missing): string {
	if (name && env.iconTheme.peek().has_icon(name))
		return name
	return fallback
}

export function getBrightnessIcon(percent: number, type: "screen" | "keyboard" = "screen"): string {
	const icons = type === "keyboard" ? iconList.brightness.keyboard : iconList.brightness.screen
	if (percent === 0) return icons.off
	if (percent < 0.4) return icons.low
	if (percent < 0.8) return icons.medium
	return icons.high
}

export default iconList
