import AstalApps from "gi://AstalApps"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"

import { hyprland } from "$lib/hyprland"
import { attempt, attempt_async, err, ok, type Result } from "$lib/result"

export async function launch_program(argv: readonly string[]): Promise<Result<void>> {
	if (!argv.length || !argv[0] || argv.some(arg => arg.includes("\0")))
		return err(new Error("A program and valid arguments are required"))
	const result = await attempt_async(() =>
		hyprland.message_async(`dispatch exec ${argv.map(arg => GLib.shell_quote(arg)).join(" ")}`),
	)
	if (!result.ok) return result
	if (result.value.trim() !== "ok") return err(new Error(`Launch rejected: ${result.value}`))
	return ok(undefined)
}

export async function launch_app(app: AstalApps.Application): Promise<Result<void>> {
	const found = attempt(() => {
		const entry = app.get_entry()
		return entry ? GioUnix.DesktopAppInfo.new(entry)?.get_filename() : null
	})
	if (!found.ok) return found
	if (found.value) return launch_program(["gio", "launch", found.value])
	const launched = attempt(() => app.launch())
	if (!launched.ok) return launched
	if (!launched.value) return err(new Error(`Could not launch ${app.get_entry()}`))
	return ok(undefined)
}
