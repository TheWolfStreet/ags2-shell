import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { attempt_async, type Result } from "$lib/result"

export function run_command(
	args: string[],
	{ timeout_ms = 15_000 }: { timeout_ms?: number } = {},
): Promise<Result<string>> {
	return attempt_async(async () => {
		const process = Gio.Subprocess.new(
			args,
			Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
		)
		let timed_out = false
		const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout_ms, () => {
			timed_out = true
			process.force_exit()
			return GLib.SOURCE_REMOVE
		})
		try {
			const [output, error] = await new Promise<[string, string]>(
				(resolve, reject) => {
					process.communicate_utf8_async(null, null, (_source, response) => {
						try {
							const [, stdout, stderr] =
								process.communicate_utf8_finish(response)
							resolve([stdout, stderr])
						} catch (reason) {
							reject(reason)
						}
					})
				},
			)
			if (timed_out) throw new Error(`Timed out running ${args[0]}`)
			if (!process.get_successful())
				throw new Error(error.trim() || `${args[0]} failed`)
			return output.trim()
		} finally {
			if (!timed_out) GLib.Source.remove(deadline)
		}
	})
}
