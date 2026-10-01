import app from "$lib/app"
import { createBinding, createComputed, createState, For, onCleanup, With } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"

import AstalApps from "gi://AstalApps"

import { ApplicationIcon } from "widget/shared/ApplicationIcon"
import { Placeholder } from "widget/shared/Placeholder"
import { PopupWindow, Position } from "widget/shared/PopupWindow"
import { PanelButton } from "../PanelButton"
import { rank_apps, display_apps } from "./search"

import { launch_app } from "$lib/apps"
import { log_error } from "$lib/result"
import { applications } from "$service/apps"
import icons from "$lib/icons"
import options, { Opt, surface_scale, ui_scale } from "$shell/options"

type search_result = { app: AstalApps.Application; rank: number }

const { OVERLAY } = Astal.Layer
const { NORMAL } = Astal.Exclusivity
const { ON_DEMAND } = Astal.Keymode
const { SLIDE_DOWN, SLIDE_UP } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation
const { CENTER, END } = Gtk.Align
const { LEFT } = Gtk.Justification
const { ALT_MASK } = Gdk.ModifierType
const digit_keys = [
	Gdk.KEY_1, Gdk.KEY_2, Gdk.KEY_3, Gdk.KEY_4, Gdk.KEY_5,
	Gdk.KEY_6, Gdk.KEY_7, Gdk.KEY_8, Gdk.KEY_9,
] as const

const { position } = options.launcher
const launcher_scale = createComputed(() => surface_scale(options.launcher.scale, 0.5))
const icon_size = createComputed(() => Math.round(64 * ui_scale() * launcher_scale()))
const is_on_bottom = createComputed(() => position() === "bottom-center")
const app_transition = is_on_bottom.as((bottom) => bottom ? SLIDE_UP : SLIDE_DOWN)
let update_search_entry: ((query: string, visible: boolean) => void) | null = null

export namespace Launcher {
	export function set_search_query(query: string, ensure_visible = true) {
		update_search_entry?.(query, ensure_visible)
	}

	export function Button() {
		return (
			<PanelButton targetWindow="launcher">
				<box class="launcher horizontal">
					<image iconName={options.bar.launcher.icon} useFallback />
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		const existing = app.get_window("launcher")
		if (existing) return existing
		let window: Astal.Window & { set_requested_visible(visible: boolean): void }
		let entry: Gtk.Entry | null = null
		const [text, set_text] = createState("")
		const favorites = createBinding(applications, "favorites")
		const all_apps = createBinding(applications, "list")
		const search_index = createComputed(() => all_apps().map((candidate) => ({
			app: candidate,
			name: candidate.get_name().toLowerCase(),
		})))
		const ranked_apps = createComputed(() => {
			const limit = Math.max(0, Math.min(9, options.launcher.apps.max()))
			return rank_apps(search_index(), text(), limit)
		})
		const displayed_apps = createComputed(() => display_apps(ranked_apps(), is_on_bottom()))
		const show_favorites = createComputed(() => !text() &&
			["launcher", "both"].includes(options.favorites.location()))
		const not_found = createComputed(() => !!text().trim() && !ranked_apps().length)
		const launcher_css = createComputed(() => {
			const scale = launcher_scale()
			const margin = options.launcher.margin() * ui_scale() * scale
			return [
				is_on_bottom() ? `margin-bottom: ${margin}pt;` : `margin-top: ${margin}pt;`,
				`--padding: calc(var(--ui-padding) * ${scale});`,
				`--spacing: calc(var(--ui-spacing) * ${scale});`,
				`--radius: calc(var(--ui-radius) * ${scale});`,
				`--border-width: calc(var(--ui-border-width) * ${scale});`,
				`--font-size: calc(var(--ui-font-size) * ${scale});`,
				`--icon-size: calc(var(--ui-icon-size) * ${scale});`,
				`--popover-padding: calc(var(--ui-popover-padding) * ${scale});`,
				`--popover-radius: calc(var(--ui-popover-radius) * ${scale});`,
				`--scale: ${ui_scale() * scale};`,
			].join("")
		})
		const launch = (candidate?: AstalApps.Application) => {
			if (!candidate) return
			window.hide()
			void launch_app(candidate).then(result => log_error(result, "launcher: Could not launch application"))
		}
		const SearchEntry = () => (
			<entry
				$={(self) => { entry = self }}
				text={text}
				placeholderText="Search"
				primaryIconName="system-search-symbolic"
				onNotifyText={(self) => set_text(self.get_text())}
				onActivate={() => launch(ranked_apps.peek()[0])}
			/>
		)
		const NotFound = () => (
			<revealer halign={CENTER} revealChild={not_found}
				transitionType={app_transition} transitionDuration={options.transition.duration}>
				<Placeholder iconName={icons.ui.search} iconSize={icon_size} label="No results found" />
			</revealer>
		)
		const Results = () => (
			<box orientation={VERTICAL}>
				<For each={displayed_apps} id={(result) => `${result.app.get_entry()}:${result.rank}`}>
					{(result) => <AppEntry result={result} launch={launch} />}
				</For>
			</box>
		)
		const Favorites = () => (
			<revealer revealChild={show_favorites} transitionType={app_transition}
				transitionDuration={options.transition.duration}>
				<box orientation={VERTICAL}>
					<Gtk.Separator visible={is_on_bottom.as((bottom) => !bottom)} />
					<box class="quicklaunch horizontal">
						<For each={favorites} id={(favorite) => favorite.get_entry()}>
							{(favorite) => (
								<button tooltipText={favorite.get_name()} onClicked={() => launch(favorite)} hexpand>
									<ApplicationIcon icon={favorite.get_icon_name()} size={icon_size} />
								</button>
							)}
						</For>
					</box>
					<Gtk.Separator visible={is_on_bottom} />
				</box>
			</revealer>
		)

		update_search_entry = (query, visible) => {
			if (visible) window.set_requested_visible(true)
			set_text(query)
			entry?.grab_focus()
		}
		onCleanup(() => { update_search_entry = null })

		return (
			<PopupWindow
				name="launcher" exclusivity={NORMAL} keymode={ON_DEMAND} layer={OVERLAY}
				layout={position as Opt<Position>} application={app}
				onKey={(_ctrl, keyval, _code, mod) => {
					if ((mod & ALT_MASK) !== ALT_MASK) return
					const rank = digit_keys.indexOf(keyval as typeof digit_keys[number])
					if (rank < 0) return
					if (displayed_apps.peek().length) launch(displayed_apps.peek()[rank]?.app)
					else if (show_favorites.peek()) launch(favorites.peek()[rank])
				}}
				$={(self) => { window = self }}
				onNotifyVisible={(self) => {
					if (self.visible) entry?.grab_focus()
					else set_text("")
				}}
			>
				<With value={is_on_bottom}>
					{(bottom) => bottom ? (
						<box class="launcher" orientation={VERTICAL} css={launcher_css}>
							<Results /><Favorites /><NotFound /><SearchEntry />
						</box>
					) : (
						<box class="launcher" orientation={VERTICAL} css={launcher_css}>
							<SearchEntry /><NotFound /><Favorites /><Results />
						</box>
					)}
				</With>
			</PopupWindow>
		) as Gtk.Window
	}
}

function AppEntry({ result, launch }: { result: search_result; launch: (app: AstalApps.Application) => void }) {
	const { app, rank } = result
	return (
		<box orientation={VERTICAL}>
			<Gtk.Separator visible={is_on_bottom.as((bottom) => !bottom)} />
			<button class="app-item" onClicked={() => launch(app)}>
				<box>
					<ApplicationIcon icon={app.get_icon_name()} size={icon_size} />
					<box valign={CENTER} orientation={VERTICAL}>
						<label class="title" hexpand xalign={0} label={app.name} />
						{app.description && (
							<label class="description" hexpand wrap maxWidthChars={30}
								justify={LEFT} valign={CENTER} xalign={0} label={app.description} />
						)}
					</box>
					<label class="launch-hint" hexpand halign={END} label={`󰘳 ${rank + 1}`} />
				</box>
			</button>
			<Gtk.Separator visible={is_on_bottom} />
		</box>
	)
}
