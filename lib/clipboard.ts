import Gio from "gi://Gio"

import { attempt, err, ok, type result } from "$lib/result"
import { timeout } from "$lib/time"

export type clipboard_content = string | { path: string; mime_type: string }

export async function copy_to_clipboard(
	content: clipboard_content,
): Promise<result<void>> {
	const is_text = typeof content === "string"
	const launcher = new Gio.SubprocessLauncher({
		flags: is_text ? Gio.SubprocessFlags.STDIN_PIPE : Gio.SubprocessFlags.NONE,
	})
	const args = ["setsid", "wl-copy"]
	if (!is_text) {
		launcher.set_stdin_file_path(content.path)
		args.push("--type", content.mime_type)
	}
	const spawned = attempt(() => launcher.spawnv(args))
	if (!spawned.ok) return spawned
	const process = spawned.value
	const cancellable = new Gio.Cancellable()
	const deadline = timeout(5000, () => {
		cancellable.cancel()
		process.force_exit()
	})
	const finished = await new Promise<result<unknown>>((resolve) => {
		const started = attempt(() =>
			process.communicate_utf8_async(
				is_text ? content : null,
				cancellable,
				(_source, response) => {
					deadline.cancel()
					resolve(attempt(() => process.communicate_utf8_finish(response)))
				},
			),
		)
		if (started.ok) return
		deadline.cancel()
		process.force_exit()
		resolve(started)
	})
	if (!finished.ok) return finished
	if (!process.get_successful()) return err(new Error("wl-copy failed"))
	return ok(undefined)
}
