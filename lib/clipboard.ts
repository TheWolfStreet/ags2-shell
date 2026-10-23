import Gio from "gi://Gio"

import { attempt, attempt_async, type Result } from "$lib/result"
import { timeout } from "$lib/time"

export type clipboard_content = string | { path: string; mime_type: string }

export function copy_to_clipboard(
	content: clipboard_content,
): Promise<Result<void>> {
	return attempt_async(
		() =>
			new Promise<void>((resolve, reject) => {
				const is_text = typeof content === "string"
				const launcher = new Gio.SubprocessLauncher({
					flags: is_text
						? Gio.SubprocessFlags.STDIN_PIPE
						: Gio.SubprocessFlags.NONE,
				})
				const args = ["setsid", "wl-copy"]
				if (!is_text) {
					launcher.set_stdin_file_path(content.path)
					args.push("--type", content.mime_type)
				}
				const process = launcher.spawnv(args)
				const cancellable = new Gio.Cancellable()
				const deadline = timeout(5000, () => {
					cancellable.cancel()
					process.force_exit()
				})
				process.communicate_utf8_async(
					is_text ? content : null,
					cancellable,
					(_source, result) => {
						deadline.cancel()
						const finished = attempt(() =>
							process.communicate_utf8_finish(result),
						)
						if (!finished.ok) reject(finished.err)
						else if (!process.get_successful())
							reject(new Error("wl-copy failed"))
						else resolve()
					},
				)
			}),
	)
}
