import { bind, Variable, GLib } from "astal"
import { App, Gtk, Astal } from "astal/gtk3"

import { Calendar, ScrolledWindow, Separator } from "../../GtkWidgets"
import PopupWindow, { Position } from "../../PopupWindow"
import { NotificationList } from "../components/NotificationPopups"
import PanelButton from "./PanelButton"

import { env } from "../../../lib/environment"
import { notifd } from "../../../lib/services"
import { toggleWindow } from "../../../lib/utils"
import icons from "../../../lib/icons"
import options from "../../../options"

const { CENTER } = Gtk.Align
const { SLIDE_DOWN, SLIDE_UP } = Gtk.RevealerTransitionType
const { NEVER } = Gtk.PolicyType
const { bar, datemenu } = options
const layout = Variable.derive([bar.position, datemenu.position], (bar, qs) => `${bar}-${qs}` as Position)

export const DateMenuBtn = ({ format = options.bar.date.format() }) =>
	<PanelButton
		name="datemenu"
		halign={CENTER}
		onClick={() => toggleWindow("datemenu")}
	>
		<label
			valign={CENTER}
			label={env.clock(v => v.format(format.get())!)}
		/>
	</PanelButton>

const hasNotifications = bind(notifd, "notifications").as(
	n => n.filter(notification =>
		!options.notifications.blacklist.get().includes(notification.appName || notification.desktopEntry)
	).length > 0
)

const Placeholder = () =>
	<box className="placeholder" visible={hasNotifications.as(v => !v)} vertical valign={CENTER} halign={CENTER} vexpand hexpand>
		<icon icon={icons.notifications.silent} useFallback />
		<label label={"No new notifications"} />
	</box>

const ClearButton = () =>
	<button sensitive={hasNotifications} onClicked={() => notifd.notifications.forEach((n) => n.dismiss())}>
		<box className="horizontal">
			<label label={"Clear"} />
			<icon icon={icons.trash[hasNotifications ? "full" : "empty"]} useFallback />
		</box>
	</button>

const Header = () =>
	< box className="notifications-header" >
		<label label={"Notifications"} hexpand xalign={0} />
		<ClearButton />
	</box >

const NotifyColumn = () =>
	<box className="notifications" vertical vexpand={false}
		css={"min-width: 400px;"}
	>
		<Header />
		<ScrolledWindow
			className="notification-scrollable" hscrollbarPolicy={NEVER}>
			<box className="notification-list vertical" vexpand hexpand vertical>
				<NotificationList persistent={true} />
				<Placeholder />
			</box >
		</ScrolledWindow>
	</box>

function up(up: number) {
	const h = Math.floor(up / 60)
	const m = Math.floor(up % 60)
	return `uptime: ${h}:${m < 10 ? "0" + m : m}`
}

const DateColumn = () =>
	<box className="date-column vertical" vertical>
		<box className="clock-box" vertical>
			<label className="clock" label={env.clock((t: GLib.DateTime) => t.format("%H:%M") ?? undefined)}
			/>
			<label className="uptime" label={env.uptime(up)}></label>
		</box>
		<box className="calendar" hexpand > <Calendar halign={CENTER} /></box>
	</box >

const DateMenu = () =>
	<PopupWindow
		name="datemenu"
		exclusivity={Astal.Exclusivity.EXCLUSIVE}
		transitionType={options.bar.position((pos) => pos === "top" ? SLIDE_DOWN : SLIDE_UP)}
		layout={layout.get()}
		child={
			<box className="datemenu horizontal" >
				<NotifyColumn />
				<Separator />
				<DateColumn />
			</box>
		}
	/>

export default function setupDateMenu() {
	App.add_window(DateMenu() as Gtk.Window)
	layout.subscribe(() => {
		(DateMenu() as Gtk.Window).close()
		App.remove_window(DateMenu() as Gtk.Window)
		App.add_window(DateMenu() as Gtk.Window)
	})
}
