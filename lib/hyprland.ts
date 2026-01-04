import { hypr } from "./services"
import { setHandler } from "./option"

import options from "options"

const {
	hyprland,
	theme: {
		spacing,
		radius,
		border: { width },
		blur,
		blurOnLight,
		shadows,
		dark: {
			primary: { bg: darkActive },
		},
		light: {
			primary: { bg: lightActive },
		},
		scheme,
	},
} = options


const deps = [
	"hyprland",
	spacing.id,
	radius.id,
	blur.id,
	blurOnLight.id,
	width.id,
	shadows.id,
	darkActive.id,
	lightActive.id,
	scheme.id,
]

function primary() {
	return scheme.peek() === "dark"
		? darkActive.peek()
		: lightActive.peek()
}

function rgba(color: string) {
	return `rgba(${color}ff)`.replace("#", "")
}

async function sendBatch(batch: string[]) {
	const cmd = batch
		.filter(x => !!x)
		.map(x => `keyword ${x}`)
		.join("; ")
	hypr.message(`[[BATCH]]/${cmd}`)
}

async function setHyprland() {
	const gaps = Math.floor(hyprland.gaps.peek() * spacing.peek());
	const darkMode = scheme.peek().includes("dark");
	const blurPolicy = darkMode || blurOnLight.peek();
	const blurEnabled = blur.peek() > 0 && blurPolicy;

	const baseRules = [
		"layerrule unset, *",
	];

	const blurRules = [
		"layerrule blur, gtk4-layer-shell",
		"layerrule blurpopups, gtk4-layer-shell",
		"layerrule ignorealpha .29, gtk4-layer-shell",
	];

	const generalRules = [
		`general:border_size ${width.peek()}`,
		`general:gaps_out ${gaps}`,
		`general:gaps_in ${Math.floor(gaps / 2)}`,
		`general:col.active_border ${rgba(primary())}`,
		`general:col.inactive_border ${rgba(hyprland.inactiveBorder.peek())}`,
		`decoration:rounding ${radius.peek()}`,
		`decoration:shadow:enabled ${shadows.peek() ? "yes" : "no"}`,
		"layerrule noanim, gtk4-layer-shell",
	];

	sendBatch(blurEnabled ? [...baseRules, ...blurRules] : baseRules);
	sendBatch(generalRules);
}

export default function hyprinit() {
	hypr.connect("config-reloaded", () => setHyprland())
	setHandler(options, deps, setHyprland)
	setHyprland()
}
