import {
	Accessor,
	createState,
	createBinding,
	createComputed,
	createRoot,
	onCleanup,
} from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "$lib/app"
import { createPoll } from "ags/time"
import { timeout } from "$lib/time"

import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import { PanelButton } from "../PanelButton"

import icons, { substitute_icon_name } from "$lib/icons"
import { decode_size } from "$lib/pixels"
import { classify_image_uri, create_texture_accessor } from "$lib/textures"
import {
	notification_action_available,
	notification_daemon,
} from "$lib/notifications"
import { notification_manager } from "$service/notifications"
import {
	create_entry_lifecycle,
	is_live,
	type entry_lifecycle,
} from "./entry_lifecycle"

import options, { scaled } from "$shell/options"
import { capture_kinds } from "$service/screen_capture"

export namespace Notifications {
	export const pending = createBinding(notification_manager, "notifications")

	export function Button() {
		return (
			<PanelButton
				target_window="datemenu"
				class="messages"
				visible={pending.as((v) => v.length > 0)}
				tooltipText={pending.as(
					(v) => `${v.length} pending notification${v.length === 1 ? "" : "s"}`,
				)}
			>
				<image iconName={icons.notifications.message} useFallback />
			</PanelButton>
		)
	}

	export function Window() {
		const anchor = options.notifications.position.as(anchor_for_position)
		const [popup_count, set_popup_count] = createState(0)
		return (
			<window
				visible={popup_count.as((count) => count > 0)}
				resizable={false}
				heightRequest={1}
				widthRequest={popup_width}
				name="notifications"
				class="notifications"
				application={app}
				exclusivity={NORMAL}
				anchor={anchor}
			>
				<scrolledwindow
					widthRequest={popup_width}
					hscrollbarPolicy={EXTERNAL}
					vscrollbarPolicy={AUTOMATIC}
					propagateNaturalHeight
				>
					<NotificationList
						class="notifications-stack"
						persistent={false}
						on_count_changed={set_popup_count}
						transition_type={options.notifications.position.as((position) =>
							position.startsWith("bottom") ? SLIDE_UP : SLIDE_DOWN,
						)}
					/>
				</scrolledwindow>
			</window>
		)
	}

	export function animate_dismiss_all() {
		const queue = notification_daemon.get_notifications().sort(newest_first)
		const dismiss_from = (index: number) => {
			const notification = queue[index]
			if (is_live(notification)) notification.dismiss()
			if (index + 1 < queue.length) timeout(50, () => dismiss_from(index + 1))
		}
		if (queue.length) timeout(Math.random() * 100, () => dismiss_from(0))
	}

	const popup_width = scaled(350)

	type transition_type =
		Accessor<Gtk.RevealerTransitionType> | Gtk.RevealerTransitionType

	type notification_props = {
		entry: AstalNotifd.Notification
		state: entry_lifecycle
		persistent: boolean
		transition_type: transition_type
	}

	type list_entry = {
		notification: AstalNotifd.Notification
		state: entry_lifecycle
		widget: Gtk.Widget
		dispose: () => void
		next?: AstalNotifd.Notification
	}

	type header_props = {
		notification: AstalNotifd.Notification
		app_icon: string
		app_name: string
		show_actions: Accessor<boolean>
		on_dismiss: () => void
	}

	type content_props = {
		notification: AstalNotifd.Notification
		image_path: string | null
		persistent: boolean
		avatar?: boolean
	}

	type actions_props = {
		actions: Array<{ label: string; id: string }>
		show_actions: Accessor<boolean>
		on_action_click: (action_id: string) => void
	}

	const minute_ticker = createPoll(0, 60_000, (tick) => tick + 1)

	function anchor_for_position(position: string) {
		const [vertical, horizontal] = position.split("-")
		const edge = vertical === "bottom" ? BOTTOM : TOP
		if (horizontal === "left") return edge | LEFT
		if (horizontal === "right") return edge | RIGHT
		return edge
	}

	function newest_first(
		left: AstalNotifd.Notification,
		right: AstalNotifd.Notification,
	) {
		return right.time - left.time
	}

	const urgency_class: Record<number, string> = {
		[AstalNotifd.Urgency.LOW]: "low",
		[AstalNotifd.Urgency.CRITICAL]: "critical",
	}

	function urgency(notification: AstalNotifd.Notification): string {
		return urgency_class[notification.urgency] ?? "normal"
	}

	function decode_markup_entities(text: string) {
		const named: Record<string, string> = {
			amp: "&",
			apos: "'",
			gt: ">",
			lt: "<",
			quot: '"',
		}

		return text.replace(
			/&(#(?:[xX][\da-fA-F]+|\d+)|amp|apos|gt|lt|quot);/g,
			(_entity, name: string) => {
				if (!name.startsWith("#")) return named[name]
				return decode_character_reference(name)
			},
		)
	}

	function decode_character_reference(reference: string) {
		const hexadecimal = reference[1]?.toLowerCase() === "x"
		const code_point = Number.parseInt(
			reference.slice(hexadecimal ? 2 : 1),
			hexadecimal ? 16 : 10,
		)
		if (!printable_code_point(code_point)) return "\uFFFD"
		return String.fromCodePoint(code_point)
	}

	function printable_code_point(code_point: number) {
		if (!Number.isInteger(code_point) || code_point > 0x10ffff) return false
		if (code_point >= 0x20) return true
		return code_point === 9 || code_point === 10 || code_point === 13
	}

	function body_text(body: string) {
		return decode_markup_entities(
			body
				.replace(
					/<img\b[^>]*>/gi,
					(tag) => tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] ?? "",
				)
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<[^>]*>/g, ""),
		)
	}

	function time_ago(time: number) {
		const now = GLib.DateTime.new_now_local()
		const then = GLib.DateTime.new_from_unix_local(time)
		if (!then) return ""
		const diff = now.to_unix() - then.to_unix()
		if (diff < 60) return "now"
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
		return `${Math.floor(diff / 86400)}d ago`
	}

	function Header({
		notification,
		app_icon,
		app_name,
		show_actions,
		on_dismiss,
	}: header_props) {
		return (
			<box class="header">
				<image class="app-icon" iconName={app_icon} useFallback />
				<label
					class="app-name"
					hexpand
					xalign={0}
					maxWidthChars={24}
					ellipsize={EllipsizeMode.END}
					label={app_name}
				/>
				<label
					class="time"
					halign={END}
					label={minute_ticker(() => time_ago(notification.time))}
				/>
				<revealer
					revealChild={show_actions}
					transitionDuration={options.transition.duration}
					transitionType={SWING_RIGHT}
				>
					<button class="close-button" onClicked={on_dismiss}>
						<image
							iconName={icons.ui.close}
							halign={CENTER}
							valign={CENTER}
							useFallback
						/>
					</button>
				</revealer>
			</box>
		)
	}

	function preview_box(persistent: boolean, avatar: boolean) {
		if (avatar) return { width: 48, height: 48 }
		if (persistent) return { width: 260, height: 160 }
		return { width: 75, height: 75 }
	}

	function fitted_height(
		texture: Gdk.Texture | null,
		width: number,
		height: number,
	) {
		if (!texture) return height
		const ratio = Math.min(
			width / texture.get_width(),
			height / texture.get_height(),
		)
		return Math.max(1, Math.round(texture.get_height() * ratio))
	}

	function natural_frame(texture: Gdk.Texture | null, width: number) {
		if (!texture) return Gdk.Paintable.new_empty(width, width)
		const longest = Math.max(texture.get_width(), texture.get_height())
		return Gdk.Paintable.new_empty(
			Math.round((texture.get_width() * width) / longest),
			Math.round((texture.get_height() * width) / longest),
		)
	}

	function Preview({
		image_path,
		persistent,
		avatar,
	}: {
		image_path: string
		persistent: boolean
		avatar: boolean
	}) {
		const box = preview_box(persistent, avatar)
		const width = scaled(box.width)
		const height = scaled(box.height)
		const texture = create_texture_accessor(
			image_path,
			decode_size(Math.max(box.width, box.height) * 2),
			"contain",
		)
		const frame = createComputed(() => natural_frame(texture(), width()))
		const height_request = avatar
			? height
			: createComputed(() => fitted_height(texture(), width(), height()))
		return (
			<overlay
				class={avatar ? "avatar" : "preview"}
				halign={START}
				valign={CENTER}
				visible={texture.as((value) => value !== null)}
			>
				<Gtk.Picture
					paintable={frame}
					widthRequest={avatar ? width : undefined}
					heightRequest={height_request}
					canShrink
				/>
				<Gtk.Picture
					$type="overlay"
					tooltipText={image_path}
					paintable={texture as unknown as Accessor<Gdk.Paintable>}
					canShrink
				/>
			</overlay>
		)
	}

	function Content({
		notification,
		image_path,
		persistent,
		avatar = false,
	}: content_props) {
		const body = body_text(notification.body)
		const preview = image_path ? (
			<Preview
				image_path={image_path}
				persistent={persistent}
				avatar={avatar}
			/>
		) : null

		return (
			<box
				class={`content${persistent ? " history" : ""}`}
				orientation={persistent && !avatar ? VERTICAL : HORIZONTAL}
			>
				{(!persistent || avatar) && preview}
				<box orientation={VERTICAL} hexpand>
					<label
						class="summary"
						wrap
						wrapMode={WORD_CHAR}
						maxWidthChars={28}
						hexpand
						xalign={0}
						tooltipText={notification.summary}
						label={notification.summary}
					/>
					{body && (
						<label
							class="body"
							wrap
							wrapMode={WORD_CHAR}
							maxWidthChars={28}
							hexpand
							xalign={0}
							tooltipText={body}
							label={body}
						/>
					)}
				</box>
				{persistent && !avatar && preview}
			</box>
		)
	}

	function Actions({ actions, show_actions, on_action_click }: actions_props) {
		if (actions.length === 0) return <box visible={false} />
		const vertical = actions.length > 3

		return (
			<revealer
				revealChild={createComputed(
					() =>
						show_actions() &&
						actions.some(({ id }) => notification_action_available(id)),
				)}
				transitionDuration={options.transition.duration}
				transitionType={SWING_DOWN}
			>
				<box
					class={`actions ${vertical ? "vertical" : "horizontal"}`}
					orientation={vertical ? VERTICAL : HORIZONTAL}
				>
					{actions.map(({ label, id }) => (
						<button
							hexpand
							visible={createComputed(() => notification_action_available(id))}
							onClicked={() => {
								if (notification_action_available(id)) on_action_click(id)
							}}
						>
							<label label={label} wrap wrapMode={WORD_CHAR} xalign={0.5} />
						</button>
					))}
				</box>
			</revealer>
		)
	}

	function preview_path(notification: AstalNotifd.Notification) {
		const image = notification.get_image()
		if (!image || classify_image_uri(image) === "unknown") return null
		return image
	}

	function is_avatar(
		notification: AstalNotifd.Notification,
		image_path: string | null,
	) {
		const cache = `${GLib.get_user_cache_dir()}/astal/notifd/`
		if (!image_path?.startsWith(cache)) return false
		if (!/^\d+\.png$/.test(image_path.slice(cache.length))) return false
		return notification.get_category()?.startsWith("im.") === true
	}

	function app_icon_name(
		notification: AstalNotifd.Notification,
		image_path: string | null,
	) {
		const image = notification.get_image()
		const named_image = image && !image_path ? image : ""
		return substitute_icon_name(
			notification.get_app_icon() ||
				named_image ||
				notification.get_desktop_entry() ||
				icons.fallback.notification,
			icons.fallback.notification,
		)
	}

	function app_label(notification: AstalNotifd.Notification) {
		const name =
			notification.get_app_name() ||
			notification.get_desktop_entry() ||
			"Notification"
		return name.toUpperCase()
	}

	function capture_directory(notification: AstalNotifd.Notification) {
		const capture = Object.values(capture_kinds).find(
			({ app_name, summary }) =>
				notification.get_app_name() === app_name &&
				notification.summary === summary,
		)
		return capture?.directory ?? null
	}

	function archived_capture(
		notification: AstalNotifd.Notification,
		persistent: boolean,
	) {
		if (!persistent) return false
		if (notification.time >= notification_manager.session_start) return false
		const directory = capture_directory(notification)
		if (!directory) return false
		if (notification.body.startsWith(directory)) return true
		return notification.get_image()?.startsWith(directory) === true
	}

	function labelled_actions(notification: AstalNotifd.Notification) {
		return notification
			.get_actions()
			.filter((action) => action.label?.trim())
			.map((action) => ({ label: action.label!, id: action.id }))
	}

	function Notification({
		entry: notification,
		state,
		persistent,
		transition_type,
	}: notification_props) {
		const [show_actions, set_show_actions] = createState(false)
		const image_path = preview_path(notification)
		const actions = archived_capture(notification, persistent)
			? []
			: labelled_actions(notification)

		return (
			<revealer
				revealChild={state.visible}
				transitionDuration={options.transition.duration}
				transitionType={transition_type}
				onMap={state.on_map}
				onNotifyChildRevealed={(self) =>
					state.on_revealed_changed(self.get_child_revealed())
				}
			>
				<box
					class={`notification ${urgency(notification)}`}
					orientation={VERTICAL}
				>
					<Gtk.EventControllerMotion
						onEnter={() => {
							state.keep_alive()
							set_show_actions(true)
						}}
						onMotion={state.keep_alive}
						onLeave={() => {
							state.resume()
							set_show_actions(false)
						}}
					/>
					<Header
						notification={notification}
						app_icon={app_icon_name(notification, image_path)}
						app_name={app_label(notification)}
						show_actions={show_actions}
						on_dismiss={state.dismiss}
					/>
					<Content
						notification={notification}
						image_path={image_path}
						persistent={persistent}
						avatar={is_avatar(notification, image_path)}
					/>
					<Actions
						actions={actions}
						show_actions={show_actions}
						on_action_click={state.on_action_click}
					/>
				</box>
			</revealer>
		)
	}

	export function NotificationList({
		class: class_name,
		persistent,
		transition_type = SLIDE_DOWN,
		on_count_changed,
	}: {
		class: string
		persistent: boolean
		transition_type?: transition_type
		on_count_changed?: (count: number) => void
	}) {
		const entries: list_entry[] = []
		const container = (
			<box class={class_name} orientation={VERTICAL} valign={START} />
		) as Gtk.Box

		function accepts(notification: AstalNotifd.Notification) {
			if (notification_manager.is_blacklisted(notification)) return false
			return persistent || !notification_manager.do_not_disturb
		}

		function entry_for(id: number) {
			return entries.find((entry) => entry.notification.id === id)
		}

		function retire(entry: list_entry) {
			entry.next = undefined
			entry.state.close()
		}

		function remove(entry: list_entry) {
			const index = entries.indexOf(entry)
			if (index < 0) return
			entries.splice(index, 1)
			entry.dispose()
			on_count_changed?.(entries.length)
			if (entry.next && is_live(entry.next)) show(entry.next)
			reconcile()
		}

		function reconcile() {
			if (!persistent) return
			const desired = notification_daemon
				.get_notifications()
				.filter(accepts)
				.sort(newest_first)
				.slice(0, list_limit)
			const desired_ids = new Set(desired.map(({ id }) => id))
			for (const entry of [...entries])
				if (!desired_ids.has(entry.notification.id)) entry.state.close()
			for (const notification of desired) show(notification)
		}

		function create_entry(notification: AstalNotifd.Notification) {
			const entry: list_entry = createRoot((dispose) => {
				const state = create_entry_lifecycle({
					notification,
					persistent,
					on_exit: () => remove(entry),
				})
				onCleanup(state.cleanup)
				const widget = (
					<Notification
						entry={notification}
						state={state}
						persistent={persistent}
						transition_type={transition_type}
					/>
				) as Gtk.Widget
				return {
					notification,
					state,
					widget,
					dispose: () => {
						container.remove(widget)
						dispose()
					},
				}
			})
			return entry
		}

		function close_overflow() {
			const open = entries.filter((entry) => !entry.state.is_closing())
			if (open.length > list_limit) open[open.length - 1].state.close()
		}

		function mount(notification: AstalNotifd.Notification) {
			const older = entries.findIndex(
				(entry) => entry.notification.time <= notification.time,
			)
			const index = older < 0 ? entries.length : older
			const entry = create_entry(notification)
			const previous = index > 0 ? entries[index - 1].widget : null
			container.insert_child_after(entry.widget, previous)
			entries.splice(index, 0, entry)
			on_count_changed?.(entries.length)
			close_overflow()
		}

		function show(notification: AstalNotifd.Notification) {
			const entry = entry_for(notification.id)
			if (!accepts(notification)) {
				if (entry) retire(entry)
				return
			}
			if (!entry) {
				mount(notification)
				return
			}
			if (entry.notification === notification && !entry.state.is_closing())
				return
			entry.next = notification
			entry.state.close()
		}

		function show_session_popups() {
			for (const notification of notification_daemon.get_notifications())
				if (notification.time >= notification_manager.session_start)
					show(notification)
		}

		const notified_handler = notification_daemon.connect(
			"notified",
			(_daemon, id: number) => {
				const notification = notification_daemon.get_notification(id)
				if (notification) show(notification)
			},
		)

		const resolved_handler = notification_daemon.connect(
			"resolved",
			(_daemon, id: number) => {
				const entry = entry_for(id)
				if (entry) retire(entry)
				else reconcile()
			},
		)

		const blacklist_unsubscribe = options.notifications.blacklist.subscribe(
			() => {
				for (const entry of [...entries])
					if (notification_manager.is_blacklisted(entry.notification))
						entry.state.close()
				reconcile()
			},
		)

		if (persistent) reconcile()
		else show_session_popups()

		onCleanup(() => {
			notification_daemon.disconnect(notified_handler)
			notification_daemon.disconnect(resolved_handler)
			blacklist_unsubscribe()
			for (const entry of entries.splice(0)) entry.dispose()
			on_count_changed?.(0)
		})

		return container
	}

	const { START, CENTER, END } = Gtk.Align
	const { VERTICAL, HORIZONTAL } = Gtk.Orientation
	const { WORD_CHAR } = Pango.WrapMode
	const { EXTERNAL, AUTOMATIC } = Gtk.PolicyType
	const { SLIDE_DOWN, SLIDE_UP, SWING_RIGHT, SWING_DOWN } =
		Gtk.RevealerTransitionType
	const { EllipsizeMode } = Pango
	const { NORMAL } = Astal.Exclusivity
	const { TOP, RIGHT, LEFT, BOTTOM } = Astal.WindowAnchor
	const list_limit = 50
}
