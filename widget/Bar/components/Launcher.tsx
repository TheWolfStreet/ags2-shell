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

const { LEFT } = Gtk.Justification
const { SLIDE_DOWN } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation
const { CENTER, END } = Gtk.Align

export namespace Launcher {
	export function Button() {
		return (
			<PanelButton
				name="launcher"
				onClicked={() => toggleWindow("launcher")}
			>
				<box class="launcher horizontal">
					<image iconName={options.bar.launcher.icon} useFallback />
				</box>
			</PanelButton>
		)
	}
	// Each entry is linked to an app from a list of apps
	// <For> deletes the entry if app from list is deleted
	// What we could do?

	export function Window() {
		let win: Astal.Window
		let entry: Gtk.Entry
		let content: Gtk.Box
		let text: Accessor<string> = createState("")[0]

		const [list, set_list] = createState<Array<AstalApps.Application>>([])

		function search(text: string) {
			if (text === "") {
				set_list([])
				return
			}

			const matched = apps.list.fuzzy_query(text)
			set_list(matched)
		}

		function launch(app?: AstalApps.Application) {
			if (app) {
				win.hide()
				app.launch()
			}
		}

		function onKey(_ctrl: Gtk.EventControllerKey, keyval: number, _code: number, mod: number) {
			if (mod === Gdk.ModifierType.ALT_MASK) {
				for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
					if (keyval === Gdk[`KEY_${i}`])
						return launch(list.get()[i - 1])
				}
			}
		}

		function Favorites() {
			const reveal = createComputed([list.as(v => v.length != 0), text.as(v => v.length != 0)],
				(hasEntries, hasText) => !hasEntries && !hasText)
			return (
				<revealer
					revealChild={reveal}
					transitionDuration={options.transition.duration}>
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
												pixelSize={64} />
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

		const Entry = ({ app, index }: { app: AstalApps.Application, index: Accessor<number> }) =>
			<revealer
				name={app.name}
				transitionType={SLIDE_DOWN}
				transitionDuration={options.transition.duration}
				onMap={self => {
					self.set_reveal_child(true)
				}}
			>
				<box orientation={VERTICAL}>
					<Gtk.Separator />
					<button class="app-item" onClicked={() => launch(app)}>
						<box>
							<image
								iconName={app.get_icon_name()}
								gicon={Gio.DesktopAppInfo.new(app.get_entry())?.get_icon() ?? undefined}
								pixelSize={64} />
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
							<label class="launch-hint" hexpand halign={END} label={index.as(i => `󰘳${i + 1}`)} />
						</box>
					</button>
				</box>
			</revealer>

		const { OVERLAY } = Astal.Layer
		const { NORMAL } = Astal.Exclusivity
		const { ON_DEMAND } = Astal.Keymode

		return (
			<PopupWindow
				name={"launcher"}
				exclusivity={NORMAL}
				keymode={ON_DEMAND}
				layer={OVERLAY}
				layout="top-center"
				application={app}
				onKey={onKey}
				$={w => {
					win = w
				}}
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
					$={b => content = b}
					css={options.launcher.margin.as((m: any) => `margin-top: ${m}pt;`)}
				>
					<entry
						$={e => {
							entry = e
							text = createBinding(entry, "text")
						}}
						placeholderText="Search"
						primaryIconName="system-search-symbolic"
						onNotifyText={e => {
							search(e.text)
						}}
					/>
					<revealer
						halign={CENTER}
						revealChild={createComputed([list.as(v => v.length != 0),
						text.as(v => v.length != 0)],
							(hasEntries, hasText) => !hasEntries && hasText)}
						transitionType={SLIDE_DOWN}
						transitionDuration={options.transition.duration}
					>
						<Placeholder iconName={icons.ui.search} label={"No results found"} />
					</revealer >
					<Favorites />
					<box orientation={VERTICAL}>
						<For
							each={list.as(l =>
								l.slice(0, options.launcher.apps.max.get())
							)}
						>
							{(app: AstalApps.Application, index) => <Entry app={app} index={index} /> as Gtk.Revealer}
						</For>
					</box>
				</box>
			</PopupWindow>
		) as Gtk.Window
	}
}
