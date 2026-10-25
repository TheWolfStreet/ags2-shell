import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt, err, ok, type result } from "$lib/result"

function communicate(
	process: Gio.Subprocess,
): Promise<result<[boolean, string, string]>> {
	return new Promise((resolve) =>
		process.communicate_utf8_async(null, null, (_source, response) =>
			resolve(attempt(() => process.communicate_utf8_finish(response))),
		),
	)
}

export async function run_command(
	args: string[],
	{ timeout_ms = 15_000 }: { timeout_ms?: number } = {},
): Promise<result<string>> {
	const spawned = attempt(() =>
		Gio.Subprocess.new(
			args,
			Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
		),
	)
	if (!spawned.ok) return spawned
	const process = spawned.value
	let timed_out = false
	const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout_ms, () => {
		timed_out = true
		process.force_exit()
		return GLib.SOURCE_REMOVE
	})
	const finished = await communicate(process)
	if (!timed_out) GLib.Source.remove(deadline)
	if (!finished.ok) return finished
	const [, stdout, stderr] = finished.value
	if (timed_out) return err(new Error(`Timed out running ${args[0]}`))
	if (!process.get_successful())
		return err(new Error(stderr.trim() || `${args[0]} failed`))
	return ok(stdout.trim())
}
