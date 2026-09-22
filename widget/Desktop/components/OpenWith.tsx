// Lets the user pick an application for a file, Nautilus-style, with an
// "always use" switch that sets the default handler for the file type.

import app from "ags/gtk4/app"
import {
	createComputed,
	createRoot,
	createState,
	For,
} from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { idle } from "ags/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import { attempt } from "$lib/result"
import { Placeholder } from "widget/shared/Placeholder"

export namespace DesktopOpenWith {
	export function open(filePath: string) {
		const type = contentTypeOf(filePath)
		const recommended = Gio.AppInfo.get_recommended_for_type(type).map(toEntry)
		const seen = new Set(recommended.map((entry) => entry.id))
		const others = Gio.AppInfo.get_all_for_type(type)
			.map(toEntry)
			.filter((entry) => entry.app.should_show() && !seen.has(entry.id))
			.sort((left, right) => left.name.localeCompare(right.name))

		const fallback =
			Gio.AppInfo.get_default_for_type(type, false)?.get_id() ?? ""
		const preselected =
			recommended.some((entry) => entry.id === fallback) ||
			others.some((entry) => entry.id === fallback)
				? fallback
				: (recommended[0]?.id ?? "")

		setFilePath(filePath)
		setContentType(type)
		setRecommended(recommended)
		setOthers(others)
		setSelectedId(preselected)
		setQuery("")
		setAlwaysUse(false)
		ensureWindow()?.present()
		idle(() => searchEntry?.grab_focus())
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
					onKeyPressed={(_, key) => {
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
							sensitive={hasSelection}
							onClicked={confirm}
						/>
					</centerbox>
					<box class="open-with-body" orientation={VERTICAL}>
						<entry
							class="search"
							placeholderText="Search applications"
							primaryIconName="system-search-symbolic"
							text={query}
							onNotifyText={(self) => setQuery(self.text)}
							$={(self) => (searchEntry = self)}
						/>
						<label
							class="prompt"
							label={promptMarkup}
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
									visible={filteredRecommended.as((entries) => entries.length > 0)}
								/>
								<For each={filteredRecommended}>
									{(entry) => <AppRow entry={entry} />}
								</For>
								<label
									class="section"
									label="Other Apps"
									xalign={0}
									visible={filteredOthers.as((entries) => entries.length > 0)}
								/>
								<For each={filteredOthers}>
									{(entry) => <AppRow entry={entry} />}
								</For>
								<Placeholder
									iconName="system-search-symbolic"
									label="No results found"
									visible={hasNoResults}
								/>
							</box>
						</Gtk.ScrolledWindow>
						<box class="always-row" orientation={HORIZONTAL}>
							<box orientation={VERTICAL} valign={CENTER} hexpand>
								<label label="Always use for this file type" xalign={0} />
								<label class="detail" label={typeDescription} xalign={0} />
							</box>
							<switch
								active={alwaysUse}
								valign={CENTER}
								onNotifyActive={(self) => setAlwaysUse(self.active)}
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

type OpenWithApp = {
	id: string
	name: string
	detail: string
	icon: Gio.Icon | null
	app: Gio.AppInfo
}

const [filePath, setFilePath] = createState("")
const [contentType, setContentType] = createState("application/octet-stream")
const [recommended, setRecommended] = createState<OpenWithApp[]>([])
const [others, setOthers] = createState<OpenWithApp[]>([])
const [selectedId, setSelectedId] = createState("")
const [query, setQuery] = createState("")
const [alwaysUse, setAlwaysUse] = createState(false)
let searchEntry: Gtk.Entry | null = null
let root: (() => void) | null = null

const promptMarkup = filePath.as((path) => {
	const name = GLib.markup_escape_text(path.split("/").pop() || path, -1)
	return `Choose an app to open <b>${name}</b>`
})
const typeDescription = contentType.as((type) =>
	Gio.content_type_get_description(type),
)
const hasSelection = selectedId.as(Boolean)

const filteredRecommended = createComputed(() => filterApps(recommended()))
const filteredOthers = createComputed(() => filterApps(others()))
const hasNoResults = createComputed(
	() => filteredRecommended().length === 0 && filteredOthers().length === 0,
)
const selectedApp = createComputed(
	() =>
		[...recommended(), ...others()].find(
			(entry) => entry.id === selectedId(),
		) ?? null,
)

function filterApps(entries: OpenWithApp[]): OpenWithApp[] {
	const needle = query().trim().toLowerCase()
	if (!needle) return entries
	return entries.filter((entry) =>
		`${entry.name}\n${entry.detail}`.toLowerCase().includes(needle),
	)
}

function iconNameOf(icon: Gio.Icon | null): string {
	if (icon instanceof Gio.ThemedIcon) return icon.get_names()[0] ?? ""
	return ""
}

function toEntry(info: Gio.AppInfo): OpenWithApp {
	return {
		id: info.get_id() ?? info.get_name() ?? "unknown",
		name: info.get_name() ?? "Unknown",
		detail: info.get_description() ?? info.get_executable() ?? "",
		icon: info.get_icon(),
		app: info,
	}
}

function contentTypeOf(path: string): string {
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

function AppRow({ entry }: { entry: OpenWithApp }) {
	const selected = selectedId.as((id) => id === entry.id)
	const iconName = iconNameOf(entry.icon)
	return (
		<button
			class={selected.as((active) => `app-option${active ? " selected" : ""}`)}
			onClicked={() => setSelectedId(entry.id)}
		>
			<box orientation={HORIZONTAL}>
				{entry.icon ? (
					<image gicon={entry.icon} pixelSize={32} />
				) : (
					<image
						iconName={iconName || "application-x-executable-symbolic"}
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
	const entry = selectedApp.peek()
	if (!entry) return
	const target = Gio.File.new_for_path(filePath.peek())
	const launched = attempt(() => entry.app.launch([target], null))
	if (!launched.ok || !launched.value) {
		console.error(
			`desktop.openWith: Failed to launch ${target.get_path()}`,
			launched.ok ? "launch returned false" : launched.err,
		)
		return
	}
	attempt(() => entry.app.set_as_last_used_for_type(contentType.peek()))
	if (alwaysUse.peek()) setAsDefault(entry)
	hide()
}

function setAsDefault(entry: OpenWithApp) {
	const type = contentType.peek()
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

function ensureWindow() {
	const existing = app.get_window("desktop-open-with")
	if (existing) return existing

	let window: Gtk.Window | null = null
	root ??= createRoot((dispose) => {
		window = DesktopOpenWith.Window() as Gtk.Window
		return dispose
	})
	return window
}
