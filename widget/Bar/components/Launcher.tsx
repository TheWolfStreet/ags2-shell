import { Accessor, createBinding, createComputed, createState, For } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import AstalApps from "gi://AstalApps"

import { Placeholder } from "widget/shared/Placeholder"
import PopupWindow from "widget/shared/PopupWindow"
import PanelButton from "./PanelButton"

import { apps } from "$lib/services"
import { toggleWindow } from "$lib/utils"

import options from "options"
import icons from "$lib/icons"
import app from "ags/gtk4/app"

const { VERTICAL } = Gtk.Orientation
const { CENTER, END } = Gtk.Align

export const Launcher = () =>
	<PanelButton
		name="launcher"
		onClicked={() => toggleWindow("launcher")}
		$={() => app.add_window(AppLauncher() as Gtk.Window)}
	>
		<box class="launcher horizontal">
			<image iconName={options.bar.launcher.icon.get()} useFallback />
		</box>
	</PanelButton>

function AppLauncher() {
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
		const [favs, _] = createState(apps.favorites);
		const reveal = createComputed([list.as(v => v.length != 0), text.as(v => v.length != 0)], (hasEntries, hasText) => !hasEntries && !hasText)
		return (
			<revealer revealChild={reveal}>
				<box orientation={VERTICAL}>
					<Gtk.Separator />
					<box class="quicklaunch horizontal">
						<For each={favs}>
							{(app: AstalApps.Application) =>
								app ? (
									<button tooltipText={app.name} onClicked={() => launch(app)} hexpand>
										<image iconName={app.iconName} pixelSize={64} />
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

	const AppEntry = ({ app, index }: { app: AstalApps.Application, index: Accessor<number> }) =>
		<revealer
			name={app.name}
			transitionType={Gtk.RevealerTransitionType.SLIDE_UP}
			visible={true}
			revealChild={true}
		>
			<box orientation={VERTICAL}>
				<Gtk.Separator />
				<button class="app-item" onClicked={() => launch(app)}>
					<box>
						<image iconName={app.iconName || app.entry} pixelSize={64} />
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
						<label class="launch-hint" hexpand halign={END} label={index.as(i => `󰘳${i + 1}`)} />
					</box>
				</button>
			</box>
		</revealer>

	const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
	const { NORMAL } = Astal.Exclusivity
	const { ON_DEMAND } = Astal.Keymode

	return (
		<PopupWindow
			name={"launcher"}
			anchor={TOP | BOTTOM | LEFT | RIGHT}
			exclusivity={NORMAL}
			keymode={ON_DEMAND}
			layout="top-center"
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
					$={(e) => {
						entry = e
						text = createBinding(entry, "text")
					}}
					placeholderText="Search"
					primaryIconName="system-search-symbolic"
					onNotifyText={e => search(e.text)}
				/>
				<revealer
					halign={CENTER}
					transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
					revealChild={createComputed([list.as(v => v.length != 0), text.as(v => v.length != 0)], (hasEntries, hasText) => !hasEntries && hasText)}
				>
					<Placeholder iconName={icons.ui.search} label={"No results found"} />
				</revealer >
				<Favorites />
				<box orientation={VERTICAL}>
					<For each={list}>
						{(app, index) => <AppEntry app={app} index={index} />}
					</For>
				</box>
			</box>
		</PopupWindow>
	) as Gtk.Window
}
