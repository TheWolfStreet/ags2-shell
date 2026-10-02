import app from "$lib/app"
import { type Accessor, createBinding, createComputed, createState, For, onCleanup, onMount, With } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"

import AstalApps from "gi://AstalApps"

import { ApplicationIcon } from "widget/shared/ApplicationIcon"
import { Placeholder } from "widget/shared/Placeholder"
import { PopupWindow, Position } from "widget/shared/PopupWindow"
import { PanelButton } from "../PanelButton"
import { rank_apps, display_apps } from "./search"

import { launch_app } from "$lib/apps"
import { log_error } from "$lib/result"
import { idle } from "$lib/time"
import { applications } from "$service/apps"
import icons from "$lib/icons"
import options, { Opt, surface_scale, ui_scale } from "$shell/options"

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
			const limit = options.launcher.apps.max() || 9
			return rank_apps(search_index(), text(), limit)
		})
		const displayed_apps = createComputed(() => display_apps(ranked_apps(), is_on_bottom()))
		const app_by_entry = createComputed(() => new Map(all_apps().map(candidate => [candidate.get_entry(), candidate])))
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
		const Results = () => {
			let box: Gtk.Box
			let shown: string[] = []
			let pending: string[] | null = null
			let updating = false
			const revealers = new Map<string, Gtk.Revealer>()
			const entries = createComputed(() => displayed_apps().map(result => result.app.get_entry()))

			const finish = () => {
				if (updating || !pending) return
				if ([...revealers.values()].some(row => row.get_reveal_child() === false && row.get_child_revealed() && row.get_mapped())) return
				const ordered = pending
				pending = null
				let previous: Gtk.Revealer | null = null
				for (const id of ordered) {
					const row = revealers.get(id)
					if (!row) continue
					box.reorder_child_after(row, previous)
					previous = row
				}
				shown = ordered
				for (const [id, row] of revealers) row.set_reveal_child(ordered.includes(id))
			}

			const update = () => {
				const next = entries.peek()
				updating = true
				if (shown.some((id, index) => next.includes(id) && next[index] !== id)) {
					pending = next
					for (const row of revealers.values()) row.set_reveal_child(false)
				} else {
					pending = next
					for (const [id, row] of revealers) {
						if (!next.includes(id)) row.set_reveal_child(false)
					}
				}
				updating = false
				finish()
			}

			onMount(() => {
				const unsub = entries.subscribe(update)
				update()
				onCleanup(unsub)
			})
			return (
				<box orientation={VERTICAL} $={self => { box = self }}>
					<For each={all_apps} id={candidate => candidate.get_entry()}>
						{candidate => {
							const id = candidate.get_entry()
							const current = app_by_entry.as(apps => apps.get(id) ?? candidate)
							const rank = createComputed(() => displayed_apps().find(result => result.app.get_entry() === id)?.rank)
							return <AppEntry app={current} rank={rank} launch={launch} register={row => {
								revealers.set(id, row)
								const handler = row.connect("notify::child-revealed", finish)
								const refresh = box && entries.peek().includes(id) ? idle(update) : null
								onCleanup(() => {
									refresh?.cancel()
									row.disconnect(handler)
									if (revealers.get(id) === row) revealers.delete(id)
								})
							}} />
						}}
					</For>
				</box>
			)
		}
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

function AppEntry({ app, rank, launch, register }: {
	app: Accessor<AstalApps.Application>
	rank: Accessor<number | undefined>
	launch: (app: AstalApps.Application) => void
	register: (row: Gtk.Revealer) => void
}) {
	const [icon_ready, set_icon_ready] = createState(false)
	return (
		<revealer name={app.peek().get_entry()} revealChild={false} transitionType={app_transition}
			transitionDuration={options.transition.duration} $={row => {
				register(row)
				const handler = row.connect("notify::reveal-child", () => {
					if (row.get_reveal_child()) set_icon_ready(true)
				})
				onCleanup(() => row.disconnect(handler))
			}}>
			<box orientation={VERTICAL}>
				<Gtk.Separator visible={is_on_bottom.as((bottom) => !bottom)} />
				<button class="app-item" onClicked={() => launch(app())}>
					<box>
						<ApplicationIcon icon={createComputed(() => icon_ready() ? app().get_icon_name() : "")} size={icon_size} />
						<box valign={CENTER} orientation={VERTICAL}>
							<label class="title" hexpand xalign={0} label={app.as(candidate => candidate.name)} />
							<label class="description" hexpand wrap maxWidthChars={30}
								justify={LEFT} valign={CENTER} xalign={0}
								visible={app.as(candidate => !!candidate.description)}
								label={app.as(candidate => candidate.description ?? "")} />
						</box>
						<label class="launch-hint" hexpand halign={END}
							label={rank.as(value => value !== undefined && value < 9 ? `󰘳 ${value + 1}` : "")} />
					</box>
				</button>
				<Gtk.Separator visible={is_on_bottom} />
			</box>
		</revealer>
	)
}
