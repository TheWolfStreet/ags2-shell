import app from "$lib/app"
import {
	createComputed,
	createRoot,
	createState,
	For,
} from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { idle } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import { attempt } from "$lib/result"
import { Placeholder } from "widget/shared/Placeholder"

export namespace DesktopOpenWith {
	export function open(file_path: string) {
		const type = content_type_of(file_path)
		const recommended = Gio.AppInfo.get_recommended_for_type(type).map(to_entry)
		const seen = new Set(recommended.map((entry) => entry.id))
		const others = Gio.AppInfo.get_all_for_type(type)
			.map(to_entry)
			.filter((entry) => entry.app.should_show() && !seen.has(entry.id))
			.sort((left, right) => left.name.localeCompare(right.name))

		const fallback =
			Gio.AppInfo.get_default_for_type(type, false)?.get_id() ?? ""
		const preselected =
			recommended.some((entry) => entry.id === fallback) ||
			others.some((entry) => entry.id === fallback)
				? fallback
				: (recommended[0]?.id ?? "")

		set_file_path(file_path)
		set_content_type(type)
		set_recommended(recommended)
		set_others(others)
		set_selected_id(preselected)
		set_query("")
		set_always_use(false)
		ensure_window()?.present()
		idle(() => search_entry?.grab_focus())
	}

	export function Window() {
		const existing = app.get_window("desktop-open-with")
		if (existing) return existing

		return (
			<Gtk.Window
				title="Open File"
				name="desktop-open-with"
				class="desktop-open-with"
				application={app}
				defaultWidth={500}
				defaultHeight={620}
				hideOnClose
				iconName="application-x-executable-symbolic"
			>
				<Gtk.EventControllerKey
					onKeyPressed={(unused, key) => {
						if (key === KEY_Escape) {
							hide()
							return true
						}
						return false
					}}
				/>
				<box orientation={VERTICAL}>
					<centerbox class="header">
						<button
							$type="start"
							class="cancel"
							label="Cancel"
							onClicked={hide}
						/>
						<label $type="center" class="title" label="Open File" />
						<button
							$type="end"
							class="suggested-action"
							label="Open"
							sensitive={has_selection}
							onClicked={confirm}
						/>
					</centerbox>
					<box class="open-with-body" orientation={VERTICAL}>
						<entry
							class="search"
							placeholderText="Search applications"
							primaryIconName="system-search-symbolic"
							text={query}
							onNotifyText={(self) => set_query(self.text)}
							$={(self) => (search_entry = self)}
						/>
						<label
							class="prompt"
							label={prompt_markup}
							useMarkup
							wrap
							justify={Gtk.Justification.CENTER}
							xalign={0.5}
							halign={CENTER}
						/>
						<Gtk.ScrolledWindow
							vexpand
							hscrollbarPolicy={Gtk.PolicyType.NEVER}
						>
							<box class="app-list" orientation={VERTICAL}>
								<label
									class="section"
									label="Recommended Apps"
									xalign={0}
									visible={filtered_recommended.as((entries) => entries.length > 0)}
								/>
								<For each={filtered_recommended}>
									{(entry) => <AppRow entry={entry} />}
								</For>
								<label
									class="section"
									label="Other Apps"
									xalign={0}
									visible={filtered_others.as((entries) => entries.length > 0)}
								/>
								<For each={filtered_others}>
									{(entry) => <AppRow entry={entry} />}
								</For>
								<Placeholder
									iconName="system-search-symbolic"
									label="No results found"
									visible={has_no_results}
								/>
							</box>
						</Gtk.ScrolledWindow>
						<box class="always-row" orientation={HORIZONTAL}>
							<box orientation={VERTICAL} valign={CENTER} hexpand>
								<label label="Always use for this file type" xalign={0} />
								<label class="detail" label={type_description} xalign={0} />
							</box>
							<switch
								active={always_use}
								valign={CENTER}
								onNotifyActive={(self) => set_always_use(self.active)}
							/>
						</box>
					</box>
				</box>
			</Gtk.Window>
		)
	}
}

const { KEY_Escape } = Gdk
const { CENTER } = Gtk.Align
const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { EllipsizeMode } = Pango

type open_with_app = {
	id: string
	name: string
	detail: string
	icon: Gio.Icon | null
	app: Gio.AppInfo
}

const [file_path, set_file_path] = createState("")
const [content_type, set_content_type] = createState("application/octet-stream")
const [recommended, set_recommended] = createState<open_with_app[]>([])
const [others, set_others] = createState<open_with_app[]>([])
const [selected_id, set_selected_id] = createState("")
const [query, set_query] = createState("")
const [always_use, set_always_use] = createState(false)
let search_entry: Gtk.Entry | null = null
let root: (() => void) | null = null

const prompt_markup = file_path.as((path) => {
	const name = GLib.markup_escape_text(path.split("/").pop() || path, -1)
	return `Choose an app to open <b>${name}</b>`
})
const type_description = content_type.as((type) =>
	Gio.content_type_get_description(type),
)
const has_selection = selected_id.as(Boolean)

const filtered_recommended = createComputed(() => filter_apps(recommended()))
const filtered_others = createComputed(() => filter_apps(others()))
const has_no_results = createComputed(
	() => filtered_recommended().length === 0 && filtered_others().length === 0,
)
const selected_app = createComputed(
	() =>
		[...recommended(), ...others()].find(
			(entry) => entry.id === selected_id(),
		) ?? null,
)

function filter_apps(entries: open_with_app[]): open_with_app[] {
	const needle = query().trim().toLowerCase()
	if (!needle) return entries
	return entries.filter((entry) =>
		`${entry.name}\n${entry.detail}`.toLowerCase().includes(needle),
	)
}

function to_entry(info: Gio.AppInfo): open_with_app {
	return {
		id: info.get_id() ?? info.get_name() ?? "unknown",
		name: info.get_name() ?? "Unknown",
		detail: info.get_description() ?? info.get_executable() ?? "",
		icon: info.get_icon(),
		app: info,
	}
}

function content_type_of(path: string): string {
	const queried = attempt(() =>
		Gio.File.new_for_path(path)
			.query_info(
				"standard::content-type",
				Gio.FileQueryInfoFlags.NONE,
				null,
			)
			.get_content_type(),
	)
	if (queried.ok && queried.value) return queried.value
	return Gio.content_type_guess(path, null)[0] ?? "application/octet-stream"
}

function AppRow({ entry }: { entry: open_with_app }) {
	const selected = selected_id.as((id) => id === entry.id)
	return (
		<button
			class={selected.as((active) => `app-option${active ? " selected" : ""}`)}
			onClicked={() => set_selected_id(entry.id)}
		>
			<box orientation={HORIZONTAL}>
				{entry.icon ? (
					<image gicon={entry.icon} pixelSize={32} />
				) : (
					<image
						iconName="application-x-executable-symbolic"
						pixelSize={32}
						useFallback
					/>
				)}
				<label
					label={entry.name}
					xalign={0}
					hexpand
					ellipsize={EllipsizeMode.END}
				/>
			</box>
		</button>
	)
}

function confirm() {
	const entry = selected_app.peek()
	if (!entry) return
	const target = Gio.File.new_for_path(file_path.peek())
	const launched = attempt(() => entry.app.launch([target], null))
	if (!launched.ok || !launched.value) {
		console.error(
			`desktop.openWith: Failed to launch ${target.get_path()}`,
			launched.ok ? "launch returned false" : launched.err,
		)
		return
	}
	const last_used = attempt(() => entry.app.set_as_last_used_for_type(content_type.peek()))
	if (!last_used.ok || !last_used.value)
		console.error("desktop.openWith: Failed to record last used application",
			last_used.ok ? "operation returned false" : last_used.err)
	if (always_use.peek()) set_as_default(entry)
	hide()
}

function set_as_default(entry: open_with_app) {
	const type = content_type.peek()
	const updated = attempt(() => entry.app.set_as_default_for_type(type))
	if (updated.ok && updated.value) return
	if (entry.id.endsWith(".desktop")) {
		void execAsync(["gio", "mime", type, entry.id]).catch((error) =>
			console.error(
				`desktop.openWith: Failed to set default for ${type}`,
				error,
			),
		)
		return
	}
	console.error(
		`desktop.openWith: Failed to set default for ${type}`,
		updated.ok ? "set_as_default_for_type returned false" : updated.err,
	)
}

function hide() {
	app.get_window("desktop-open-with")?.hide()
}

function ensure_window() {
	const existing = app.get_window("desktop-open-with")
	if (existing) return existing

	let window: Gtk.Window | null = null
	root ??= createRoot((dispose) => {
		window = DesktopOpenWith.Window() as Gtk.Window
		return dispose
	})
	return window
}
