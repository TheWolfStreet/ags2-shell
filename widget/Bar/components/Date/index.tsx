import app from "ags/gtk4/app"
import { Astal, Gtk } from "ags/gtk4"
import { createBinding } from "ags"

import { Placeholder } from "widget/shared/Placeholder"
import { PopupWindow } from "widget/shared/PopupWindow"
import { Notifications } from "../Notifications"
import { PanelButton } from "../PanelButton"

import env from "$lib/env"
import { notifications } from "$lib/services"
import icons from "$lib/icons"
import { popupLayout, toggleWindow } from "$lib/utils"

import options from "options"

const { CENTER } = Gtk.Align
const { NEVER } = Gtk.PolicyType
const { EXCLUSIVE } = Astal.Exclusivity
const { VERTICAL } = Gtk.Orientation

export namespace Date {
	const layout = popupLayout(options.bar.position, options.datemenu.position)
	const notifList = createBinding(notifications, "notifications")

	function uptimeFmt(up: number) {
		const h = Math.floor(up / 60)
		const m = up % 60
		return `uptime: ${h}:${m < 10 ? "0" + m : m}`
	}

	function ClearButton() {
		const trashIcon = notifList.as(n => icons.trash[n.length ? "full" : "empty"])
		return (
			<button
				onClicked={Notifications.dismissAll}
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
						<Notifications.Stack class="notification-list vertical" persistent={true} />
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
						label={env.clock(v => v.format("%H:%M") ?? "")}
					/>
					<label
						class="uptime"
						label={env.uptime(uptimeFmt)}
					/>
				</box>
				<box class="calendar" hexpand>
					<Gtk.Calendar halign={CENTER} />
				</box>
			</box>
		)
	}

	export function Button() {
		return (
			<PanelButton
				name="datemenu"
				halign={CENTER}
				onClicked={() => toggleWindow("datemenu")}
			>
				<label
					valign={CENTER}
					label={env.clock((v) => v.format(options.bar.date.format.peek()) ?? "")}
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
}
