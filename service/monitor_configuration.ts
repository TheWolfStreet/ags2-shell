import { is_record } from "$lib/json"
import { lua_string } from "$lib/lua"

export type monitor_settings = {
	name: string
	width: number
	height: number
	refreshRate: number
	x: number
	y: number
	scale: number
	transform: number
	mirrorOf?: string | null
}

const numeric_fields = [
	"x",
	"y",
	"width",
	"height",
	"refreshRate",
	"scale",
	"transform",
] as const

export function is_monitor_settings(value: unknown): value is monitor_settings {
	if (!is_record(value)) return false
	if (typeof value.name !== "string") return false
	return numeric_fields.every(
		(key) => typeof value[key] === "number" && Number.isFinite(value[key]),
	)
}

export function format_monitor_command(
	monitor: monitor_settings,
	change: {
		refresh_rate?: number
		mirror?: string
		disabled?: boolean
	} = {},
): string {
	const refresh_rate = change.refresh_rate ?? monitor.refreshRate
	const mirror = change.mirror ?? monitor.mirrorOf
	const fields = [
		`output = ${lua_string(monitor.name)}`,
		`mode = ${lua_string(`${monitor.width}x${monitor.height}@${refresh_rate}`)}`,
		`position = ${lua_string(`${monitor.x}x${monitor.y}`)}`,
		`scale = ${monitor.scale}`,
		`transform = ${monitor.transform}`,
		`mirror = ${lua_string(mirror || "none")}`,
	]
	if (change.disabled !== undefined)
		fields.push(`disabled = ${change.disabled}`)
	return `eval hl.monitor({ ${fields.join(", ")} })`
}
