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
	const transform = monitor.transform ? `,transform,${monitor.transform}` : ""
	const source = mirror && mirror !== "none" ? `,mirror,${mirror}` : ""
	return `keyword monitor ${monitor.name},${monitor.width}x${monitor.height}@${refresh_rate},${monitor.x}x${monitor.y},${monitor.scale}${transform}${source}`
}
