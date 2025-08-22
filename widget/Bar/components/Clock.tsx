import { Astal, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { createBinding, createComputed } from "ags"

import icons from "$lib/icons"
import { toggleWindow } from "$lib/utils"
import { notifd } from "$lib/services"
import { env } from "$lib/env"

import PopupWindow, { Position } from "widget/shared/PopupWindow"
import { Placeholder } from "widget/shared/Placeholder"

import PanelButton from "./PanelButton"

import options from "options"

const { CENTER } = Gtk.Align
const { SLIDE_DOWN, SLIDE_UP } = Gtk.RevealerTransitionType
const { NEVER } = Gtk.PolicyType
const { EXCLUSIVE } = Astal.Exclusivity
const { VERTICAL } = Gtk.Orientation

const layout = createComputed(
	[options.bar.position, options.datemenu.position],
	(bar, dm) => `${bar}-${dm}` as Position
)

const hasNotifications = createBinding(notifd, "notifications").as(
	n =>
		n.filter(notification =>
			!options.notifications.blacklist.get().includes(notification.appName || notification.desktopEntry)
		).length > 0
)

function up(up: number) {
	const h = Math.floor(up / 60)
	const m = up % 60
	return `uptime: ${h}:${m < 10 ? "0" + m : m}`
}

export default () =>
	<PanelButton
		name="datemenu"
		halign={CENTER}
		onClicked={() => toggleWindow("datemenu")}
		$={() => {
			const dateMenu = DateMenu()
			app.add_window(dateMenu)
		}
		}
	>
		<label
			valign={CENTER}
			label={env.clock((v) => v.format(options.bar.date.format.get()) ?? "")}
		/>
	</PanelButton>

const ClearButton = () =>
	<button
		onClicked={() =>
			notifd.notifications.forEach(n => n.dismiss())
		}
	>
		<box class="horizontal">
			<label label="Clear" />
			<image iconName={hasNotifications.as(v => icons.trash[v ? "full" : "empty"])} useFallback />
		</box>
	</button>

const Header = () =>
	<box class="notifications-header">
		<label label="Notifications" hexpand xalign={0} />
		<ClearButton />
	</box>

const NotifyColumn = () =>
	<box class="notifications" orientation={VERTICAL}>
		<Header />
		<Gtk.ScrolledWindow class="notification-scrollable" hscrollbarPolicy={NEVER}>
			<box class="notification-list vertical" vexpand hexpand>
				{/* <NotificationList /> */}
				<Placeholder iconName={icons.notifications.silent} label={"No new notifications"} />
			</box>
		</Gtk.ScrolledWindow>
	</box>

const DateColumn = () =>
	<box class="date-column vertical" orientation={VERTICAL}>
		<box class="clock-box" orientation={VERTICAL}>
			<label
				class="clock"
				label={env.clock(v => v.format("%H:%M") ?? "")}
			/>
			<label
				class="uptime"
				label={env.uptime(v => up(v))}
			/>
		</box>
		<box class="calendar" hexpand>
			<Gtk.Calendar halign={CENTER} />
		</box>
	</box>


export const DateMenu = () =>
	<PopupWindow
		name="datemenu"
		exclusivity={EXCLUSIVE}
		transitionType={options.bar.position.as((v: string) => v === "top" ? SLIDE_DOWN : SLIDE_UP)}
		layout={layout}
	>
		<box class="datemenu horizontal">
			<NotifyColumn />
			<Gtk.Separator />
			<DateColumn />
		</box>
	</PopupWindow> as Gtk.Window
