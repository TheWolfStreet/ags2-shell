import Apps from "gi://AstalApps"
import { bind, Variable } from "astal"
import { Astal, Gtk } from "astal/gtk3"

import { Separator } from "../../GtkWidgets"
import PopupWindow from "../../PopupWindow"
import PanelButton from "./PanelButton"

import { icon, launchApp, onWindowToggle, toggleWindow } from "../../../lib/utils"
import icons from "../../../lib/icons"
import { apps } from "../../../lib/services"
import options from "../../../options"

const { CENTER } = Gtk.Align

const IconAppItem = ({ app }: { app: Apps.Application }) => (
	<button onClicked={() => {
		toggleWindow("launcher")
		launchApp(app)
	}}
		tooltipText={app.name}
		hexpand
	>
		<icon icon={icon(app.iconName, icons.fallback.executable)} useFallback />
	</button>
)

const AppItem = ({ app }: { app: Apps.Application }) =>
	<revealer name={app.name} vexpand={false} hexpand={false}>
		<box vertical>
			<Separator />
			<button
				className="app-item"
				onClicked={() => {
					toggleWindow("launcher")
					launchApp(app)
				}}>
				<box>
					<icon icon={app.iconName || app.entry} useFallback />
					<box valign={CENTER} vertical>
						<label
							className="title"
							hexpand
							truncate
							xalign={0}
							label={app.name}
						/>
						{app.description && (
							<label
								className="description"
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
				</box>
			</button>
		</box>
	</revealer>

function match(name: string, query: string) {
	return name.match(new RegExp(query, 'i'))
}

function Entries({ text }: { text: Variable<string> }) {
	const list = <box vertical>
		{bind(apps, "apps").as(a => a.list.map(app => (<AppItem app={app} />)))}
	</box> as Gtk.Box
	const notFound = Variable(false)

	text.subscribe(() => {
		const query = text.get()
		const visibleCount = list.get_children().filter(i => i instanceof Gtk.Revealer).reduce((i, item: Gtk.Revealer) => {
			if (!query || i >= options.launcher.apps.max.get()) {
				item.revealChild = false
				return i
			}
			if (match(item.name, query)) {
				item.revealChild = true
				return ++i
			}
			item.revealChild = false
			return i
		}, 0)
		notFound.set(query.length > 0 && !visibleCount)
	})

	const Placeholder = () =>
		<revealer
			halign={CENTER}
			className="placeholder vertical"
			revealChild={notFound()}
		>
			<box vertical>
				<icon icon={icons.ui.search} useFallback />
				<label label="No results found" />
			</box>
		</revealer>

	const Favorites = () =>
		<revealer revealChild={text(v => !v.length)}
			visible={options.launcher.apps.favorites().as(f => f.length > 0)}
		>
			<box vertical>
				<Separator />
				<box className="quicklaunch horizontal">
					{options.launcher.apps.favorites().as(favs =>
						favs.map(fs => {
							const entry = apps.apps.fuzzy_query(fs)[0]
							return entry ? <IconAppItem app={entry} /> : <box />
						})
					)}
				</box>
			</box>
		</revealer>

	return (
		<box vertical>
			<Placeholder />
			<Favorites />
			{list}
		</box>
	)
}

export const LauncherBtn = () =>
	<PanelButton
		name="launcher"
		onClick={() => toggleWindow("launcher")}
		setup={self => {
			onWindowToggle(self, "launcher", (w) => {
				self.toggleClassName("active", w.visible)
			})
		}}
	>
		<box className="launcher horizontal">
			<icon icon={options.bar.launcher.icon.icon()} useFallback />
		</box>
	</PanelButton>


export default function Launcher() {
	const text = Variable("")

	const entry = <entry
		placeholderText="Search"
		primaryIconName={icons.ui.search}
		text={text()}
		onChanged={self => text.set(self.text)}
	/>
	return (
		<PopupWindow
			name="launcher"
			layout="top"
			exclusivity={Astal.Exclusivity.NORMAL}
			keymode={Astal.Keymode.ON_DEMAND}
			onShow={() => {
				text.set("")
				entry.grab_focus()
			}}>
			<box
				className="launcher"
				vertical
				css={options.launcher.margin(v => `margin-top: ${v}pt;`)}
			>
				{entry}
				<Entries text={text} />
			</box>
		</PopupWindow>
	)
}
