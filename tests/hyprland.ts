import { load_module } from "./load_module.ts"

type hyprland_stub = { message_async?: (message: string) => Promise<string> }
type timer_stub = (ms: number, callback: () => void) => { cancel(): void }

export function load_hyprland({
	hyprland = {},
	app = {},
	timeout = () => ({ cancel() {} }),
}: {
	hyprland?: object
	app?: object
	timeout?: timer_stub
} = {}): Promise<Record<string, any>> {
	return load_module("lib/hyprland.ts", {
		"gi://AstalHyprland": { default: { get_default: () => hyprland } },
		"gi://GLib": {
			default: {
				LogLevelFlags: { LEVEL_CRITICAL: 0 },
				log_set_handler: () => 0,
				log_remove_handler: () => {},
			},
		},
		"$lib/app": { default: app },
		"$lib/time": { timeout },
	})
}

let routed: hyprland_stub = {}
const shared = await load_hyprland({
	hyprland: {
		message_async: (message: string) => routed.message_async!(message),
	},
})

export function with_hyprland_command<T extends { hyprland: object }>(
	module: T,
) {
	return {
		...module,
		hyprland_command: (message: string) => {
			routed = module.hyprland
			return shared.hyprland_command(message)
		},
	}
}
