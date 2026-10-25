import AstalApps from "gi://AstalApps"
import type AstalHyprland from "gi://AstalHyprland"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"

import { hyprland_command } from "$lib/hyprland"
import { lua_string } from "$lib/lua"
import { attempt, err, ok, type Result } from "$lib/result"

export function match_client_app(
	apps: readonly AstalApps.Application[],
	client: Pick<
		AstalHyprland.Client,
		"class" | "initialClass" | "title" | "initialTitle"
	>,
): AstalApps.Application | null {
	const classes = [client.class, client.initialClass]
		.map((value) => value?.trim().toLowerCase())
		.filter(Boolean)
	for (const field of [
		(app: AstalApps.Application) => app.get_wm_class(),
		(app: AstalApps.Application) => app.get_entry(),
		(app: AstalApps.Application) => app.get_entry()?.replace(/\.desktop$/i, ""),
		(app: AstalApps.Application) =>
			app.get_executable()?.trim().split(/\s/)[0]?.split("/").pop(),
	]) {
		const match = apps.find((app) => {
			const value = field(app)?.toLowerCase()
			return value && classes.includes(value)
		})
		if (match) return match
	}

	const titles = [client.title, client.initialTitle].map((value) =>
		value?.trim().toLowerCase(),
	)
	let match: AstalApps.Application | null = null
	for (const app of apps) {
		const name = app.get_name()?.trim().toLowerCase()
		if (!name || name.length < 4) continue
		const matches = titles.some(
			(title) =>
				title === name ||
				[" - ", " | ", " \u2014 "].some(
					(separator) =>
						title?.startsWith(name + separator) ||
						title?.endsWith(separator + name),
				),
		)
		if (!matches) continue
		if (match) return null
		match = app
	}
	return match
}

export async function launch_program(
	argv: readonly string[],
): Promise<Result<void>> {
	if (!argv.length || !argv[0] || argv.some((arg) => arg.includes("\0")))
		return err(new Error("A program and valid arguments are required"))
	return hyprland_command(
		`dispatch hl.dsp.exec_cmd(${lua_string(argv.map((arg) => GLib.shell_quote(arg)).join(" "))})`,
	)
}

export async function launch_app(
	app: AstalApps.Application,
): Promise<Result<void>> {
	const found = attempt(() => {
		const entry = app.get_entry()
		return entry ? GioUnix.DesktopAppInfo.new(entry)?.get_filename() : null
	})
	if (!found.ok) return found
	if (found.value) return launch_program(["gio", "launch", found.value])
	const launched = attempt(() => app.launch())
	if (!launched.ok) return launched
	if (!launched.value)
		return err(new Error(`Could not launch ${app.get_entry()}`))
	return ok(undefined)
}
