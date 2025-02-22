import { timeout } from "astal"

import options from "../options"
import { hypr } from "./services"

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
	return scheme.get() === "dark"
		? darkActive.get()
		: lightActive.get()
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

async function setupHyprland() {
	const wm_gaps = Math.floor(hyprland.gaps.get() * spacing.get())
	const blurPolicy =
		scheme(s => s.includes("dark")).get()
			? true
			: blurOnLight.get()

	if (!blurPolicy) {
		timeout(1, () => {
			sendBatch([
				`layerrule unset, gtk-layer-shell`,
			])
		})
	}

	if (blur.get() > 0 && blurPolicy) {
		sendBatch([
			`layerrule unset, gtk-layer-shell`,
			`layerrule blur, gtk-layer-shell`,
			`layerrule blurpopups, gtk-layer-shell`,
			`layerrule ignorealpha ${/* based on shadow color */.29}, gtk-layer-shell`,
		])
	} else {

	}

	sendBatch([
		`general:border_size ${width}`,
		`general:gaps_out ${wm_gaps}`,
		`general:gaps_in ${Math.floor(wm_gaps / 2)}`,
		`general:col.active_border ${rgba(primary())}`,
		`general:col.inactive_border ${rgba(hyprland.inactiveBorder.get())}`,
		`decoration:rounding ${radius}`,
		`decoration:shadow:enabled ${shadows.get() ? "yes" : "no"}`,
		`layerrule noanim, gtk-layer-shell`,
	])
}

export default function hyprinit() {
	options.handler(deps, setupHyprland)
	setupHyprland()
}
