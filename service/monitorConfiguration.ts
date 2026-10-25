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

export function format_monitor_command(
	monitor: monitor_settings,
	change: {
		refresh_rate?: number
		mirror?: string
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
	return `eval hl.monitor({ ${fields.join(", ")} })`
}
