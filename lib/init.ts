import { Gio, execAsync } from "astal"

import { bash } from "./utils"
import options from "../options"
import matugen from "./matugen"
import hyprinit from "./hyprland"

import setupBatteryState from "../widget/Bar/components/BatteryState"
import setupDateMenu from "../widget/Bar/components/DateMenu"
import setupQuickSettings from "../widget/Bar/components/QuickSettings"
import { wp } from "./services"

const { scheme, dark, light } = options.theme

const settings = new Gio.Settings({
	schema: "org.gnome.desktop.interface",
})

function gtk() {
	settings.set_string("color-scheme", `prefer-${scheme.get()}`)
}

async function updateGtkMode() {
	const theme = settings.get_string("gtk-theme")
	settings.set_string("gtk-theme", "")
	settings.set_string("gtk-theme", theme)
}

async function tmux() {
	const hex =
		scheme.get() === "dark" ? dark.primary.bg.get() : light.primary.bg.get();

	await bash(`tmux set -g @main_accent "${hex}"`).catch(() => { });

	const rawSessions = await bash(`tmux list-sessions -F "#S"`).catch(() => "");
	if (!rawSessions) return;

	const sessions = rawSessions.split("\n").filter(Boolean);
	for (const session of sessions) {
		bash(`tmux set-option -t ${session} @main_accent "${hex}"`).catch(() => { });
	}
}

export default async function init() {
	gtk();
	scheme.subscribe(gtk);

	// TODO: Better make it a toggleable feature
	let tmuxPresent = await execAsync("which tmux").then(() => true).catch(() => false);
	if (tmuxPresent) {
		tmux();
		options.theme.dark.primary.bg.subscribe(tmux);
		options.theme.light.primary.bg.subscribe(tmux);
		options.theme.scheme.subscribe(tmux);
	}

	updateGtkMode();
	options.handler(["theme.scheme", "autotheme"], () => updateGtkMode());
	wp.connect("notify::wallpaper", updateGtkMode);

	hyprinit();
	matugen();
	setupBatteryState();
	setupDateMenu();
	setupQuickSettings();
}
