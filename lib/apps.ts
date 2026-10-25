import AstalApps from "gi://AstalApps"
import type AstalHyprland from "gi://AstalHyprland"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"

import { hyprland_command } from "$lib/hyprland"
import { lua_string } from "$lib/lua"
import { attempt, err, ok, type result } from "$lib/result"
import { base_name } from "$lib/text"

type window_client = Pick<
	AstalHyprland.Client,
	"class" | "initialClass" | "title" | "initialTitle"
>
type app_field = (app: AstalApps.Application) => string | null | undefined

const class_fields: app_field[] = [
	(app) => app.get_wm_class(),
	(app) => app.get_entry(),
	(app) => app.get_entry()?.replace(/\.desktop$/i, ""),
	(app) => {
		const command = app.get_executable()?.trim().split(/\s/)[0]
		return command === undefined ? undefined : base_name(command)
	},
]
const title_separators = [" - ", " | ", " \u2014 "]

function normalized(values: (string | null | undefined)[]) {
	return values.map((value) => value?.trim().toLowerCase())
}

function match_by_class(
	apps: readonly AstalApps.Application[],
	client: window_client,
): AstalApps.Application | null {
	const classes = normalized([client.class, client.initialClass]).filter(
		Boolean,
	)
	for (const field of class_fields) {
		const match = apps.find((app) => {
			const value = field(app)?.toLowerCase()
			return value && classes.includes(value)
		})
		if (match) return match
	}
	return null
}

function title_names(title: string | undefined, name: string): boolean {
	if (title === name) return true
	return title_separators.some(
		(separator) =>
			title?.startsWith(name + separator) || title?.endsWith(separator + name),
	)
}

function match_by_title(
	apps: readonly AstalApps.Application[],
	client: window_client,
): AstalApps.Application | null {
	const titles = normalized([client.title, client.initialTitle])
	let match: AstalApps.Application | null = null
	for (const app of apps) {
		const name = app.get_name()?.trim().toLowerCase()
		if (!name || name.length < 4) continue
		if (!titles.some((title) => title_names(title, name))) continue
		if (match) return null
		match = app
	}
	return match
}

export function match_client_app(
	apps: readonly AstalApps.Application[],
	client: window_client,
): AstalApps.Application | null {
	return match_by_class(apps, client) ?? match_by_title(apps, client)
}

export async function launch_program(
	argv: readonly string[],
): Promise<result<void>> {
	if (!argv.length || !argv[0] || argv.some((arg) => arg.includes("\0")))
		return err(new Error("A program and valid arguments are required"))
	const command = argv.map((arg) => GLib.shell_quote(arg)).join(" ")
	return hyprland_command(`dispatch hl.dsp.exec_cmd(${lua_string(command)})`)
}

export async function launch_app(
	app: AstalApps.Application,
): Promise<result<void>> {
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
