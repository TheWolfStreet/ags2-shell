type hyprland_stub = { message_async?: (message: string) => Promise<string> }

export function with_hyprland_command<T extends { hyprland: object }>(
	module: T,
) {
	const hyprland = module.hyprland as hyprland_stub
	return {
		...module,
		hyprland_command: async (message: string) => {
			if (!hyprland.message_async)
				return { ok: false, err: new Error("No Hyprland stub") }
			let reply: string
			try {
				reply = await hyprland.message_async(message)
			} catch (error) {
				return { ok: false, err: error }
			}
			const replies = reply
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "")
			if (replies.length > 0 && replies.every((line) => line === "ok"))
				return { ok: true, value: undefined }
			return {
				ok: false,
				err: new Error(`Hyprland rejected ${message}: ${reply}`),
			}
		},
	}
}
