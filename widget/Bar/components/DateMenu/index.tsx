import app from "$lib/app"
import { Astal, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"
import { createBinding, createComputed, createState, onCleanup } from "ags"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"

import GLib from "gi://GLib"
import Graphene from "gi://Graphene"
import Gsk from "gi://Gsk"

import { Placeholder } from "widget/shared/Placeholder"
import { create_popup_position, PopupWindow } from "widget/shared/PopupWindow"
import { Notifications } from "../Notifications"
import { PanelButton } from "../PanelButton"

import { notification_manager } from "$service/notifications"
import icons from "$lib/icons"
import { on_window_toggle } from "$lib/windowing"
import { attempt, log_error } from "$lib/result"

import options from "$shell/options"

class DateMenuColumns extends Gtk.Widget {
	declare notifications: Gtk.Widget
	declare separator: Gtk.Widget
	declare date: Gtk.Widget

	set_columns(notifications: Gtk.Widget, separator: Gtk.Widget, date: Gtk.Widget) {
		this.notifications = notifications
		this.separator = separator
		this.date = date
		notifications.set_parent(this)
		separator.set_parent(this)
		date.set_parent(this)
		this.connect("notify::parent", () => {
			if (!this.get_parent())
				while (this.get_first_child()) this.get_first_child()!.unparent()
		})
	}

	override vfunc_measure(orientation: Gtk.Orientation, for_size: number): [number, number, number, number] {
		if (orientation === Gtk.Orientation.HORIZONTAL) {
			const [minimum, natural] = this.date.measure(orientation, for_size)
			const [separator_minimum, separator_natural] = this.separator.measure(orientation, for_size)
			return [2 * minimum + separator_minimum, 2 * natural + separator_natural, -1, -1]
		}
		const [, separator_width] = this.separator.measure(Gtk.Orientation.HORIZONTAL, -1)
		const date_width = for_size < 0 ? -1 : Math.max(0, Math.floor((for_size - separator_width) / 2))
		const [minimum, natural] = this.date.measure(orientation, date_width)
		return [minimum, natural, -1, -1]
	}

	override vfunc_size_allocate(width: number, height: number, baseline: number) {
		const [, separator_width] = this.separator.measure(Gtk.Orientation.HORIZONTAL, -1)
		const side = Math.max(0, Math.floor((width - separator_width) / 2))
		this.notifications.measure(Gtk.Orientation.HORIZONTAL, height)
		this.notifications.measure(Gtk.Orientation.VERTICAL, side)
		this.notifications.allocate(side, height, baseline, null)
		this.separator.allocate(width - 2 * side, height, baseline,
			Gsk.Transform.new().translate(new Graphene.Point({ x: side, y: 0 })))
		this.date.allocate(side, height, baseline,
			Gsk.Transform.new().translate(new Graphene.Point({ x: width - side, y: 0 })))
	}
}

const RegisteredDateMenuColumns = GObject.registerClass(DateMenuColumns)

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
				layout={create_popup_position(options.bar.position, options.datemenu.position)}
			>
				<box class="datemenu horizontal">
					<Columns />
				</box>
			</PopupWindow>
		) as Gtk.Window
	}

	function Columns() {
		const columns = new RegisteredDateMenuColumns()
		columns.set_columns(
			<NotifyColumn /> as Gtk.Widget,
			<Gtk.Separator orientation={VERTICAL} /> as Gtk.Widget,
			<DateColumn /> as Gtk.Widget,
		)
		return columns
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
