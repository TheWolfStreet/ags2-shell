import app from "ags/gtk4/app"
import { Accessor, createBinding, createComputed, createState, For, onCleanup } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"

import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"

import { Placeholder } from "widget/shared/Placeholder"
import { PopupWindow } from "widget/shared/PopupWindow"
import { PanelButton } from "./PanelButton"

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
	const appRevealers = new Map<string, Gtk.Revealer>()
	const desktopInfos = new Map<string, Gio.DesktopAppInfo>()
	const lcNames = new Map<string, string>()
	const maxVisible = options.launcher.apps.max.get() || 9

	function refresh(apps: AstalApps.Application[]) {
		lcNames.clear()
		desktopInfos.clear()
		for (const app of apps) {
			const appName = app.get_name()
			lcNames.set(appName, appName.toLowerCase())
			desktopInfos.set(appName, Gio.DesktopAppInfo.new(app.get_entry())!)
		}
	}

	function updateRevealers(ids: Set<string>) {
		appRevealers.forEach((r, id) => r.set_reveal_child(ids.has(id)))
	}

	function launchApp(win: Astal.Window, app?: AstalApps.Application) {
		if (app) {
			win.hide()
			app.launch()
		}
	}

	function handleKey(
		win: Astal.Window,
		keyval: number,
		mod: number,
		visibleApps: Accessor<Set<string>>,
		allApps: Accessor<AstalApps.Application[]>
	) {
		if (mod !== Gdk.ModifierType.ALT_MASK) return

		const ids = visibleApps.get()
		const appsArray = allApps.get()

		const visibleList: typeof appsArray = []
		for (const app of appsArray) {
			if (ids.has(app.get_name())) visibleList.push(app)
		}

		for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
			const app = visibleList[i - 1]
			if (app && keyval === (Gdk as any)[`KEY_${i}`]) launchApp(win, app)
		}
	}

	function Favorites({
		visibleApps,
		text,
		launch,
	}: {
		visibleApps: Accessor<Set<string>>
		text: Accessor<string>
		launch: (a: AstalApps.Application) => void
	}) {
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
											gicon={desktopInfos.get(app.get_name())?.get_icon() ?? undefined}
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

	function Entry(app: AstalApps.Application, visibleApps: Accessor<Set<string>>, launch: (a: AstalApps.Application) => void) {
		const appName = app.get_name()
		const hint = visibleApps.as(v => {
			if (!v.has(appName)) return ""
			const visibleNames = Array.from(v)
			const idx = visibleNames.indexOf(appName)
			return idx >= 0 ? `󰘳 ${idx + 1}` : ""
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
								iconName={app.get_icon_name()}
								gicon={desktopInfos.get(appName)?.get_icon() ?? undefined}
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
		visibleApps: Accessor<Set<string>>
		launch: (a: AstalApps.Application) => void
	}) {
		return (
			<box
				orientation={VERTICAL}
				$={b => {
					function populateApps() {
						while (b.get_first_child()) b.remove(b.get_first_child()!)
						const currentList = apps.list.get_list()
						refresh(currentList)
						allApps.get().forEach(app => b.append(Entry(app, visibleApps, launch)))
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
		const allApps = createBinding(apps, "list").as(v => v.get_list())

		const visibleApps = createComputed([text, allApps], (t, apps) => {
			const result: string[] = []
			if (t) {
				const txt = t.toLowerCase()
				for (const app of apps) {
					const appName = app.get_name()
					if (lcNames.get(appName)!.includes(txt)) {
						result.push(appName)
						if (result.length >= maxVisible) break
					}
				}
			}
			return new Set(result)
		})

		const notFound = createComputed([text.as(t => t), visibleApps], (t, v) => t.length > 0 && v.size === 0)

		return (
			<PopupWindow
				name="launcher"
				exclusivity={NORMAL}
				keymode={ON_DEMAND}
				layer={OVERLAY}
				layout="top-center"
				application={app}
				onKey={(_ctrl, keyval, _code, mod) => handleKey(win, keyval, mod, visibleApps, allApps)}
				$={w => (win = w)}
				onNotifyVisible={w => {
					if (w.visible) {
						entry.set_text("")
						entry.grab_focus()
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
							updateRevealers(visibleApps.get())
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
					<Favorites visibleApps={visibleApps} text={text} launch={a => launchApp(win, a)} />
					<AppList allApps={allApps} visibleApps={visibleApps} launch={a => launchApp(win, a)} />
				</box>
			</PopupWindow>
		) as Gtk.Window
	}
}
