import app from "ags/gtk4/app"
import { Accessor, createBinding, createComputed, createState, For, onCleanup } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"

import AstalApps from "gi://AstalApps"
import GioUnix from "gi://GioUnix"

import { Placeholder } from "widget/shared/Placeholder"
import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "../PanelButton"

import { apps } from "$lib/services"
import icons from "$lib/icons"
import { toggleWindow } from "$lib/utils"

import options from "options"

const { OVERLAY } = Astal.Layer
const { NORMAL } = Astal.Exclusivity
const { ON_DEMAND } = Astal.Keymode

const { SLIDE_DOWN } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation
const { CENTER, END } = Gtk.Align

export namespace Launcher {
	const allApps = createBinding(apps, "list").as(v => v.get_list())
	const appRevealers = new Map<string, Gtk.Revealer>()
	const desktopInfoCache = new Map<string, GioUnix.DesktopAppInfo | null>()

	function getDesktopInfo(app: AstalApps.Application): GioUnix.DesktopAppInfo | undefined {
		const appName = app.get_name()
		if (!desktopInfoCache.has(appName)) {
			desktopInfoCache.set(appName, GioUnix.DesktopAppInfo.new(app.get_entry()))
		}
		return desktopInfoCache.get(appName) ?? undefined
	}

	function updateRevealers(visibleApps: AstalApps.Application[]) {
		const visibleNames = new Set(visibleApps.map(app => app.get_name()))
		appRevealers.forEach((revealer, appName) => {
			revealer.set_reveal_child(visibleNames.has(appName))
		})
	}

	function launchApp(win: Astal.Window, app?: AstalApps.Application) {
		if (app) {
			win.hide()
			app.launch()
		}
	}

	function onKeyHandler(
		win: Astal.Window,
		keyval: number,
		mod: number,
		visibleApps: AstalApps.Application[],
		favorites: AstalApps.Application[],
	) {
		if (mod !== Gdk.ModifierType.ALT_MASK) return

		for (let i = 0; i < Math.min(visibleApps.length, 9); i++) {
			const key = (Gdk as any)[`KEY_${i + 1}`]
			if (keyval === key) {
				launchApp(win, visibleApps[i])
				return
			}
		}

		if (visibleApps.length == 0) {
			for (let i = 0; i < Math.min(favorites.length, 9); i++) {
				const key = (Gdk as any)[`KEY_${i + 1}`]
				if (keyval === key) {
					launchApp(win, favorites[i])
					return
				}
			}
		}
	}

	function Favorites({
		favorites,
		text,
		launch,
	}: {
		favorites: Accessor<AstalApps.Application[]>
		text: Accessor<string>
		launch: (a: AstalApps.Application) => void
	}) {
		return (
			<revealer revealChild={text.as(v => v.length == 0)} transitionDuration={options.transition.duration}>
				<box orientation={VERTICAL}>
					<Gtk.Separator />
					<box class="quicklaunch horizontal">
						<For each={favorites}>
							{(app: AstalApps.Application) =>
								app ? (
									<button tooltipText={app.get_name()} onClicked={() => launch(app)} hexpand>
										<image
											iconName={app.get_icon_name()}
											pixelSize={64}
										/>
									</button>
								) : (
									<box visible={false} />
								)
							}
						</For>
					</box>
				</box>
			</revealer>
		)
	}

	function Entry(app: AstalApps.Application, visibleApps: Accessor<AstalApps.Application[]>, launch: (a: AstalApps.Application) => void) {
		const appName = app.get_name()
		const hint = visibleApps.as(apps => {
			const idx = apps.findIndex(a => a.get_name() === appName)
			return idx >= 0 && idx < 9 ? `󰘳 ${idx + 1}` : ""
		})

		return (
			<revealer
				name={appName}
				transitionType={SLIDE_DOWN}
				transitionDuration={options.transition.duration}
				revealChild={false}
				$={r => appRevealers.set(appName, r)}
			>
				<box orientation={VERTICAL}>
					<Gtk.Separator />
					<button class="app-item" onClicked={() => launch(app)}>
						<box>
							<image
								gicon={getDesktopInfo(app)?.get_icon() ?? undefined}
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
										justify={Gtk.Justification.LEFT}
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

	function AppList({
		allApps,
		visibleApps,
		launch,
	}: {
		allApps: Accessor<AstalApps.Application[]>
		visibleApps: Accessor<AstalApps.Application[]>
		launch: (a: AstalApps.Application) => void
	}) {
		return (
			<box
				orientation={VERTICAL}
				$={self => {
					let initialized = false

					function populateApps() {
						if (initialized) {
							const currentApps = new Set(Array.from(self).map(child => child.name))
							const newApps = new Set(allApps.peek().map(app => app.get_name()))

							currentApps.forEach(name => {
								if (!newApps.has(name)) {
									const child = Array.from(self).find(c => c.name === name)
									if (child) self.remove(child)
									appRevealers.delete(name)
									desktopInfoCache.delete(name)
								}
							})

							allApps.peek().forEach(app => {
								if (!currentApps.has(app.get_name())) {
									self.append(Entry(app, visibleApps, launch))
								}
							})
						} else {
							allApps.peek().forEach(app => self.append(Entry(app, visibleApps, launch)))
							initialized = true
						}
					}

					populateApps()
					const unsub = createBinding(apps, "list").subscribe(populateApps)

					onCleanup(unsub)
				}}
			/>
		)
	}

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

		const [text, setText] = createState("")
		const favorites = createBinding(apps, "favorites")
		const visibleApps = createComputed(() => {
			if (!text()) return []

			const maxVisible = options.launcher.apps.max.peek() || 9
			const query = text().toLowerCase()
			const results: AstalApps.Application[] = []

			for (const app of allApps()) {
				if (app.get_name().toLowerCase().includes(query)) {
					results.push(app)
					if (results.length >= maxVisible) break
				}
			}
			return results
		})

		const notFound = createComputed(() => text().length > 0 && visibleApps().length === 0)

		return (
			<PopupWindow
				name="launcher"
				exclusivity={NORMAL}
				keymode={ON_DEMAND}
				layer={OVERLAY}
				layout="top-center"
				application={app}
				onKey={(_ctrl, keyval, _code, mod) => onKeyHandler(win, keyval, mod, visibleApps.peek(), favorites.peek())}
				$={w => (win = w)}
				onNotifyVisible={w => {
					if (w.visible) {
						entry.grab_focus()
					} else {
						entry.set_text("")
					}
				}}
			>
				<box
					class="launcher"
					orientation={VERTICAL}
					css={options.launcher.margin.as(m => `margin-top: ${m}pt;`)}
				>
					<entry
						$={e => (entry = e)}
						placeholderText="Search"
						primaryIconName="system-search-symbolic"
						onNotifyText={e => {
							setText(e.text)
							updateRevealers(visibleApps.peek())
						}}
					/>
					<revealer
						halign={CENTER}
						revealChild={notFound}
						transitionType={SLIDE_DOWN}
						transitionDuration={options.transition.duration}
					>
						<Placeholder iconName={icons.ui.search} label="No results found" />
					</revealer>
					<Favorites favorites={favorites} text={text} launch={a => launchApp(win, a)} />
					<AppList allApps={allApps} visibleApps={visibleApps} launch={a => launchApp(win, a)} />
				</box>
			</PopupWindow>
		) as Gtk.Window
	}
}
