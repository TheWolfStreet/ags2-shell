import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"

import app from "$lib/app"
import { attempt, attempt_async, err, ok, type result } from "$lib/result"
import { timeout, type timer } from "$lib/time"

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

function check_hyprland_reply(message: string, reply: string): result<void> {
	const replies = reply
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
	if (replies.length > 0 && replies.every((line) => line === "ok"))
		return ok(undefined)
	return err(new Error(`Hyprland rejected ${message}: ${reply}`))
}

export async function hyprland_command(message: string): Promise<result<void>> {
	const response = await attempt_async(() => hyprland.message_async(message))
	if (!response.ok) return response
	return check_hyprland_reply(message, response.value)
}

const monitor_retry_ms = 250
const monitor_retry_limit = 40

function monitor_names(monitors: { name?: unknown }[]): Set<string> {
	return new Set(
		monitors
			.map((monitor) => monitor.name)
			.filter((name): name is string => typeof name === "string"),
	)
}

function query_live_monitor_names(): result<Set<string>> {
	const parsed = attempt((): unknown =>
		JSON.parse(hyprland.message("j/monitors")),
	)
	if (!parsed.ok) return parsed
	const monitors = parsed.value
	if (!Array.isArray(monitors))
		return err(new Error("Unexpected monitor reply"))
	return attempt(() => monitor_names(monitors))
}

export function live_monitors(live_connectors: Set<string>) {
	return app.get_monitors().filter((monitor) => {
		const connector = monitor.get_connector()
		return connector == null || live_connectors.has(connector)
	})
}

export function watch_live_monitors(
	sync: (live_connectors: Set<string>) => void,
): () => void {
	let retry: timer | null = null
	let failures = 0

	const cancel_retry = () => {
		retry?.cancel()
		retry = null
	}

	const run = () => {
		cancel_retry()
		const live = query_live_monitor_names()
		if (live.ok) {
			failures = 0
			sync(live.value)
			return
		}
		failures += 1
		if (failures <= monitor_retry_limit) {
			retry = timeout(monitor_retry_ms, run)
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
		cancel_retry()
		app.disconnect(app_handler)
		for (const handler of hyprland_handlers) hyprland.disconnect(handler)
	}
}
