import app from "ags/gtk4/app"
import { Accessor, createBinding, createComputed, createState, For } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"

import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"

import { Placeholder } from "widget/shared/Placeholder"
import PopupWindow from "widget/shared/PopupWindow"
import PanelButton from "./PanelButton"

import { apps } from "$lib/services"
import icons from "$lib/icons"
import { toggleWindow } from "$lib/utils"

import options from "options"

const { OVERLAY } = Astal.Layer
const { NORMAL } = Astal.Exclusivity
const { ON_DEMAND } = Astal.Keymode

const { LEFT } = Gtk.Justification
const { SLIDE_DOWN } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation
const { CENTER, END } = Gtk.Align

export namespace Launcher {
	export function Button() {
		return (
			<PanelButton name="launcher" onClicked={() => toggleWindow("launcher")}>
				<box class="launcher horizontal">
					<image iconName={options.bar.launcher.icon} useFallback />
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		let win: Astal.Window
		let entry: Gtk.Entry
		let appListBox: Gtk.Box

		const appRevealers = new Map<string, Gtk.Revealer>()

		const [allApps, set_allApps] = createState<AstalApps.Application[]>([])
		const [text, set_text] = createState("")

		const visibleApps = createComputed([text, allApps], (t, apps) => {
			if (!t) return new Set<string>()
			const q = t.toLowerCase()
			return new Set(
				apps
					.filter(app => app.name.toLowerCase().includes(q))
					.slice(0, options.launcher.apps.max.get() || 9)
					.map(app => app.get_name())
			)
		})
		const notFound = createComputed([text.as(t => t), visibleApps], (t, v) => t.length > 0 && v.size === 0)

		function updateRevealers() {
			const ids = visibleApps.get()
			appRevealers.forEach((r, id) => r.set_reveal_child(ids.has(id)))
		}

		function launch(app?: AstalApps.Application) {
			if (!app) return
			win.hide()
			app.launch()
		}

		function onKey(_ctrl: Gtk.EventControllerKey, keyval: number, _code: number, mod: number) {
			if (mod === Gdk.ModifierType.ALT_MASK) {
				const visible_list = allApps.get().filter(app => visibleApps.get().has(app.get_name()))
				for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
					if (keyval === Gdk[`KEY_${i}`]) launch(visible_list[i - 1])
				}
			}
		}

		function Favorites() {
			const reveal = createComputed([visibleApps, text], (v, t) => v.size === 0 && t.length === 0)
			return (
				<revealer revealChild={reveal} transitionDuration={options.transition.duration}>
					<box orientation={VERTICAL}>
						<Gtk.Separator />
						<box class="quicklaunch horizontal">
							<For each={createBinding(apps, "favorites")}>
								{(app: AstalApps.Application) =>
									app ? (
										<button tooltipText={app.name} onClicked={() => launch(app)} hexpand>
											<image
												iconName={app.get_icon_name()}
												gicon={Gio.DesktopAppInfo.new(app.get_entry())?.get_icon() ?? undefined}
												pixelSize={64}
											/>
										</button>
									) : (
										<box />
									)
								}
							</For>
						</box>
					</box>
				</revealer>
			)
		}

		function Entry(app: AstalApps.Application) {
			const hint = createComputed([allApps, visibleApps], (apps, v) => {
				const list = apps.filter(a => v.has(a.get_name()))
				const idx = list.findIndex(a => a.get_name() === app.get_name())
				return idx >= 0 ? `󰘳 ${idx + 1}` : ''
			})

			return (
				<revealer
					name={app.get_name()}
					transitionType={SLIDE_DOWN}
					transitionDuration={options.transition.duration}
					revealChild={false}
					$={r => appRevealers.set(app.get_name(), r)}
				>
					<box orientation={VERTICAL}>
						<Gtk.Separator />
						<button class="app-item" onClicked={() => launch(app)}>
							<box>
								<image
									iconName={app.get_icon_name()}
									gicon={Gio.DesktopAppInfo.new(app.get_entry())?.get_icon() ?? undefined}
									pixelSize={64}
								/>
								<box valign={CENTER} orientation={VERTICAL}>
									<label class="title" hexpand xalign={0} label={app.name} />
									{app.description && (
										<label
											class="description"
											hexpand
											wrap
											maxWidthChars={30}
											justify={LEFT}
											valign={CENTER}
											xalign={0}
											label={app.description}
										/>
									)}
								</box>
								<label class="launch-hint" hexpand halign={END} label={hint} />
							</box>
						</button>
					</box>
				</revealer>
			) as Gtk.Revealer
		}

		function AppList() {
			return (
				<box
					orientation={VERTICAL}
					$={b => {
						appListBox = b
						set_allApps(apps.list.get_list())
						allApps.get().forEach(app => b.append(Entry(app)))
						createBinding(apps, "list").subscribe(() => {
							while (b.get_first_child()) b.remove(b.get_first_child()!)
							set_allApps(apps.list.get_list())
							allApps.get().forEach(app => b.append(Entry(app)))
						})
					}}
				/>
			)
		}

		return (
			<PopupWindow
				name="launcher"
				exclusivity={NORMAL}
				keymode={ON_DEMAND}
				layer={OVERLAY}
				layout="top-center"
				application={app}
				onKey={onKey}
				$={w => (win = w)}
				onNotifyVisible={w => {
					if (w.visible) {
						entry.set_text("")
						entry.grab_focus()
					}
				}}
			>
				<box class="launcher" orientation={VERTICAL} css={options.launcher.margin.as(m => `margin-top: ${m}pt;`)}>
					<entry
						$={e => (entry = e)}
						placeholderText="Search"
						primaryIconName="system-search-symbolic"
						onNotifyText={e => {
							set_text(e.text)
							updateRevealers()
						}}
					/>
					<revealer halign={CENTER} revealChild={notFound} transitionType={SLIDE_DOWN} transitionDuration={options.transition.duration}>
						<Placeholder iconName={icons.ui.search} label="No results found" />
					</revealer>
					<Favorites />
					<AppList />
				</box>
			</PopupWindow>
		) as Gtk.Window
	}
}
