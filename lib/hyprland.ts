// Updates Hyprland borders, gaps, shadows, blur, and animation settings.

import { hyprland as compositor } from "$service/system"
import { subscribeOptions } from "./option"
import { debounce } from "./timing"
import { idle } from "ags/time"

import options from "options"

const {
	hyprland: hyprlandOptions,
	theme: {
		spacing,
		roundness,
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
	roundness.id,
	width.id,
	opacity.id,
	blur.id,
	shadows.id,
	darkActive.id,
	lightActive.id,
	scheme.id,
]

function primary() {
	return scheme.peek() === "dark" ? darkActive.peek() : lightActive.peek()
}

function rgba(color: string) {
	return `rgba(${color}ff)`.replace("#", "")
}

async function sendBatch(batch: string[]) {
	const cmd = batch
		.filter(x => !!x)
		.map(x => `keyword ${x}`)
		.join("; ")
	compositor.message(`[[BATCH]]/${cmd}`)
}

function applyHyprland() {
	idle(() => {
		const gaps = Math.floor(hyprlandOptions.gaps.peek() * spacing.peek())
		const blurEnabled = blur.peek()

		const generalRules = [
			`general:border_size ${width.peek()}`,
			`general:gaps_out ${gaps}`,
			`general:gaps_in ${Math.floor(gaps / 2)}`,
			`general:col.active_border ${rgba(primary())}`,
			`general:col.inactive_border ${rgba(hyprlandOptions.inactiveBorder.peek())}`,
			`decoration:rounding ${roundness.peek()}`,
			`decoration:shadow:enabled ${shadows.peek() ? "yes" : "no"}`,
			`decoration:blur:enabled ${blurEnabled ? "true" : "false"}`,
		]

		sendBatch(generalRules)
	})
}

export default function hyprinit() {
	const update = debounce(100, applyHyprland)

	compositor.connect("config-reloaded", () => update.call())
	subscribeOptions(options, deps, () => update.call())
	update.call()
}
