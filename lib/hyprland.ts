import { hypr } from "./services"
import { setHandler } from "./option"
import { idle, timeout, Timer } from "ags/time"

import options from "options"

let hyprUpdateTimeout: Timer | null = null

const {
	hyprland,
	theme: {
		spacing,
		radius,
		border: { width },
		opacity,
		blur,
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
	width.id,
	opacity.id,
	blur.id,
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
	if (hyprUpdateTimeout) {
		hyprUpdateTimeout.cancel()
	}

	hyprUpdateTimeout = timeout(100, () => {
		idle(() => {
			const gaps = Math.floor(hyprland.gaps.peek() * spacing.peek());
			const blurEnabled = blur.peek();

			const generalRules = [
				`general:border_size ${width.peek()}`,
				`general:gaps_out ${gaps}`,
				`general:gaps_in ${Math.floor(gaps / 2)}`,
				`general:col.active_border ${rgba(primary())}`,
				`general:col.inactive_border ${rgba(hyprland.inactiveBorder.peek())}`,
				`decoration:rounding ${radius.peek()}`,
				`decoration:shadow:enabled ${shadows.peek() ? "yes" : "no"}`,
				`decoration:blur:enabled ${blurEnabled ? "true" : "false"}`,
			];

			sendBatch(generalRules);
		})

		hyprUpdateTimeout = null
	})
}

export default function hyprinit() {
	hypr.connect("config-reloaded", () => setHyprland())
	setHandler(options, deps, setHyprland)
	setHyprland()
}
