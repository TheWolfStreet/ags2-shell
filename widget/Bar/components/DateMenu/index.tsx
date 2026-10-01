import app from "$lib/app"
import { Astal, Gtk } from "ags/gtk4"
import { createBinding, createComputed, createState, onCleanup } from "ags"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"

import GLib from "gi://GLib"

import { Placeholder } from "widget/shared/Placeholder"
import { PopupWindow, Position } from "widget/shared/PopupWindow"
import { Notifications } from "../Notifications"
import { PanelButton } from "../PanelButton"

import { notification_manager } from "$service/notifications"
import icons from "$lib/icons"
import { on_window_toggle } from "$lib/windowing"
import { attempt, log_error } from "$lib/result"

import options, { Opt } from "$shell/options"

export namespace DateMenu {
	export function Button() {
		return (
			<PanelButton
				targetWindow="datemenu"
				halign={CENTER}
			>
				<label
					valign={CENTER}
					label={createComputed(() => clock().format(options.bar.date.format()) ?? "")}
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
				layout={options.datemenu.position as Opt<Position>}
			>
				<centerbox class="datemenu horizontal">
					<NotifyColumn $type="start" />
					<Gtk.Separator $type="center" orientation={VERTICAL} />
					<DateColumn $type="end" />
				</centerbox>
			</PopupWindow>
		) as Gtk.Window
	}

	const notification_list = createBinding(notification_manager, "notifications")
	const clock = createPoll<GLib.DateTime>(
		GLib.DateTime.new_now_local(),
		1000,
		() => GLib.DateTime.new_now_local(),
	)
	function format_uptime(up: number) {
		const h = Math.floor(up / 60)
		const m = up % 60
		return `uptime: ${h}:${m < 10 ? "0" + m : m}`
	}

	function ClearButton() {
		const trash_icon = notification_list.as((entries) => icons.trash[entries.length ? "full" : "empty"])
		return (
			<button
				onClicked={Notifications.animate_dismiss_all}
				sensitive={notification_list.as((entries) => entries.length > 0)}
				valign={CENTER}
			>
				<box>
					<label label="Clear" />
					<image iconName={trash_icon} useFallback />
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
		const no_notifications = notification_list.as((entries) => entries.length === 0)
		return (
			<box class="notifications" orientation={VERTICAL} vexpand>
				<Header />
				<Gtk.ScrolledWindow class="notification-scrollable" hscrollbarPolicy={NEVER}>
					<box vexpand orientation={VERTICAL}>
						<Notifications.Stack class="notification-list vertical" />
						<revealer revealChild={no_notifications} transitionDuration={options.transition.duration}>
							<Placeholder iconName={icons.notifications.silent} label={"No new notifications"} />
						</revealer>
					</box>
				</Gtk.ScrolledWindow>
			</box>
		)
	}

	function DateColumn() {
		const [uptime, set_uptime] = createState(0)
		const [shown, set_shown] = createState(false)
		let uptime_source = 0
		const stop = () => {
			if (uptime_source) GLib.Source.remove(uptime_source)
			uptime_source = 0
		}
		const update = () => {
			const result = attempt(() => Math.floor(Number(readFile("/proc/uptime").split(" ")[0]) / 60))
			if (log_error(result, "datemenu.uptime: Failed to read uptime") && Number.isFinite(result.value))
				set_uptime(result.value)
		}
		const unsubscribe = on_window_toggle("datemenu", (window) => {
			stop()
			set_shown(window.visible)
			if (window.visible) {
				update()
				uptime_source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60_000, () => {
					update()
					return GLib.SOURCE_CONTINUE
				})
			}
		})
		onCleanup(() => { stop(); unsubscribe() })
		return (
			<box class="date-column vertical" orientation={VERTICAL}>
				<box class="clock-box" orientation={VERTICAL}>
					<label
						class="clock"
						label={createComputed(() => shown() ? clock().format("%H:%M") ?? "" : "")}
					/>
					<label
						class="uptime"
						label={uptime(format_uptime)}
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
