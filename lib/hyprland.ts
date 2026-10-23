import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"

import app from "$lib/app"
import { attempt, attempt_async, err, ok, type Result } from "$lib/result"
import { timeout, type Timer } from "$lib/time"

function create_hyprland() {
	const critical = GLib.LogLevelFlags.LEVEL_CRITICAL
	const known_messages = [
		"json_node_get_string: assertion 'JSON_NODE_IS_VALID (node)' failed",
		"astal_hyprland_hyprland_get_client: assertion 'address != NULL' failed",
	]
	const ignore_known_warnings = (
		domain: string | null,
		level: GLib.LogLevelFlags,
		message: string,
	) => {
		if (!known_messages.some((known) => message.includes(known)))
			GLib.log_default_handler(domain, level, message, null)
	}
	const json_handler = GLib.log_set_handler(
		"Json",
		critical,
		ignore_known_warnings,
	)
	const default_handler = GLib.log_set_handler(
		"",
		critical,
		ignore_known_warnings,
	)

	try {
		return Hyprland.get_default()
	} finally {
		GLib.log_remove_handler("Json", json_handler)
		GLib.log_remove_handler("", default_handler)
	}
}

export const hyprland = create_hyprland()

export async function hyprland_command(message: string): Promise<Result<void>> {
	const response = await attempt_async(() => hyprland.message_async(message))
	if (!response.ok) return response
	const replies = response.value
		.split("\n")
		.map((reply) => reply.trim())
		.filter((reply) => reply !== "")
	if (replies.length > 0 && replies.every((reply) => reply === "ok"))
		return ok(undefined)
	return err(new Error(`Hyprland rejected ${message}: ${response.value}`))
}

function query_live_monitor_names(): Result<Set<string>> {
	return attempt(() => {
		const monitors: unknown = JSON.parse(hyprland.message("j/monitors"))
		if (!Array.isArray(monitors)) throw new Error("Unexpected monitor reply")
		return new Set(
			monitors
				.map((monitor: { name?: unknown }) => monitor.name)
				.filter((name): name is string => typeof name === "string"),
		)
	})
}

export function watch_live_monitors(
	sync: (live_connectors: Set<string>) => void,
): () => void {
	let retry: Timer | null = null
	let failures = 0

	const run = () => {
		retry?.cancel()
		retry = null
		const live = query_live_monitor_names()
		if (live.ok) {
			failures = 0
			sync(live.value)
			return
		}
		failures += 1
		if (failures <= 40) {
			retry = timeout(250, run)
			return
		}
		failures = 0
		console.error("hyprland.monitors: Failed to query monitors", live.err)
	}

	const app_handler = app.connect("notify::monitors", run)
	const hyprland_handlers = [
		hyprland.connect("monitor-added", run),
		hyprland.connect("monitor-removed", run),
	]
	run()

	return () => {
		retry?.cancel()
		retry = null
		app.disconnect(app_handler)
		for (const handler of hyprland_handlers) hyprland.disconnect(handler)
	}
}
