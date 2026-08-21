// Shows the clock and opens a calendar with notification history.

import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
import { createBinding } from "ags"
import { createPoll } from "ags/time"

import GLib from "gi://GLib"

import { Placeholder } from "widget/shared/Placeholder"
import { createPopupPosition, PopupWindow } from "widget/shared/PopupWindow"
import { Notifications } from "../Notifications"
import { PanelButton } from "../PanelButton"

import { notificationManager } from "$service/notifications"
import icons from "$lib/icons"

import options from "$shell/options"

export namespace DateMenu {
	export function Button() {
		return (
			<PanelButton
				targetWindow="datemenu"
				halign={CENTER}
			>
				<label
					valign={CENTER}
					label={clock(v => v.format(options.bar.date.format.peek()) ?? "")}
				/>
			</PanelButton >
		)
	}

	export function Window() {
		return (
			<PopupWindow
				name="datemenu"
				application={app}
				exclusivity={EXCLUSIVE}
				layout={layout}
			>
				<centerbox class="datemenu horizontal">
					<NotifyColumn $type="start" />
					<Gtk.Separator $type="center" orientation={VERTICAL} />
					<DateColumn $type="end" />
				</centerbox>
			</PopupWindow>
		) as Gtk.Window
	}

	const layout = createPopupPosition(options.bar.position, options.datemenu.position)
	const notifList = createBinding(notificationManager, "notifications")
	const clock = createPoll<GLib.DateTime>(
		GLib.DateTime.new_now_local(),
		1000,
		() => GLib.DateTime.new_now_local(),
	)
	const uptime = createPoll<number>(
		0,
		60_000,
		"cat /proc/uptime",
		line => Math.round(parseInt(line.split(".")[0], 10) / 60),
	)

	function uptimeFmt(up: number) {
		const h = Math.floor(up / 60)
		const m = up % 60
		return `uptime: ${h}:${m < 10 ? "0" + m : m}`
	}

	function ClearButton() {
		const trashIcon = notifList.as(n => icons.trash[n.length ? "full" : "empty"])
		return (
			<button
				onClicked={Notifications.animateDismissAll}
				sensitive={notifList.as(n => n.length > 0)}
				valign={CENTER}
			>
				<box>
					<label label="Clear" />
					<image iconName={trashIcon} useFallback />
				</box>
			</button>
		)
	}

	function Header() {
		return (
			<box class="notifications-header">
				<label label="Notifications" hexpand xalign={0} />
				<ClearButton />
			</box>
		)
	}

	function NotifyColumn() {
		const noNotifications = notifList.as(n => n.length === 0)
		return (
			<box class="notifications" orientation={VERTICAL} vexpand>
				<Header />
				<Gtk.ScrolledWindow class="notification-scrollable" hscrollbarPolicy={NEVER}>
					<box vexpand orientation={VERTICAL}>
						<Notifications.Stack class="notification-list vertical" />
						<revealer revealChild={noNotifications} transitionDuration={options.transition.duration}>
							<Placeholder iconName={icons.notifications.silent} label={"No new notifications"} />
						</revealer>
					</box>
				</Gtk.ScrolledWindow>
			</box>
		)
	}

	function DateColumn() {
		return (
			<box class="date-column vertical" orientation={VERTICAL}>
				<box class="clock-box" orientation={VERTICAL}>
					<label
						class="clock"
						label={clock(v => v.format("%H:%M") ?? "")}
					/>
					<label
						class="uptime"
						label={uptime(uptimeFmt)}
					/>
				</box>
				<box class="calendar" hexpand>
					<Gtk.Calendar halign={CENTER} />
				</box>
			</box>
		)
	}


	const { CENTER } = Gtk.Align
	const { NEVER } = Gtk.PolicyType
	const { EXCLUSIVE } = Astal.Exclusivity
	const { VERTICAL } = Gtk.Orientation
}
