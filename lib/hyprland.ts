import { timeout } from "ags/time"

import { hypr } from "./services"
import options from "options"
import { setHandler } from "./option"

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
	const isDark = scheme.get().includes("dark")
	const blurPolicy = isDark || blurOnLight.get()

	if (!blurPolicy) {
		timeout(1, () => {
			sendBatch([
				`layerrule unset, gtk4-layer-shell`,
			])
		})
	}

	if (blur.get() > 0 && blurPolicy) {
		sendBatch([
			`layerrule unset, gtk4-layer-shell`,
			`layerrule blur, gtk4-layer-shell`,
			`layerrule blurpopups, gtk4-layer-shell`,
			`layerrule ignorealpha ${/* based on shadow color */.29}, gtk4-layer-shell`,
		])
	} else {

	}

	sendBatch([
		`general:border_size ${width.get()}`,
		`general:gaps_out ${wm_gaps}`,
		`general:gaps_in ${Math.floor(wm_gaps / 2)}`,
		`general:col.active_border ${rgba(primary())}`,
		`general:col.inactive_border ${rgba(hyprland.inactiveBorder.get())}`,
		`decoration:rounding ${radius.get()}`,
		`decoration:shadow:enabled ${shadows.get() ? "yes" : "no"}`,
		`layerrule noanim, gtk4-layer-shell`,
	])
}

export default function hyprinit() {
	setHandler(options, deps, setupHyprland)
	setupHyprland()
}
