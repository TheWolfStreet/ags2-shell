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
import env from "$lib/env"
import { classify_image_uri, create_texture_accessor } from "$lib/textures"
import { notification_action_available, notification_daemon } from "$lib/notifications"
import { notification_manager } from "$service/notifications"
import { create_entry_lifecycle, type entry_lifecycle } from "./EntryLifecycle"

import options from "$shell/options"

export namespace Notifications {
	export function Button() {
		return (
			<PanelButton
				targetWindow="datemenu"
				class="messages"
				visible={notifications.as((v) => v.length > 0)}
				tooltipText={notifications.as(
					(v) => `${v.length} pending notification${v.length === 1 ? "" : "s"}`,
				)}
			>
				<image iconName={icons.notifications.message} useFallback />
			</PanelButton>
		)
	}

	export function Window() {
		const anchor = createComputed(() =>
			anchor_for_position(options.notifications.position()),
		)
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
		const all = notification_daemon
			.get_notifications()
			.sort((left, right) => right.time - left.time)
		let index = 0
		const dismiss_next = () => {
			const notification = all[index++]
			if (notification_daemon.get_notification(notification.id) === notification)
				notification.dismiss()
			if (index < all.length) timeout(50, dismiss_next)
		}
		if (all.length) timeout(Math.random() * 100, dismiss_next)
	}

	export function Stack({ class: class_name }: { class: string }) {
		return <NotificationList class={class_name} persistent />
	}

	const popup_width = options.scale.as((scale) =>
		Math.round((350 * scale) / 100),
	)

	type transition_type =
		| Accessor<Gtk.RevealerTransitionType>
		| Gtk.RevealerTransitionType

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

	const notifications = createBinding(notification_manager, "notifications")
	const minute_ticker = createPoll(0, 60_000, (tick) => tick + 1)

	function anchor_for_position(position: string) {
		switch (position) {
			case "top-left":
				return TOP | LEFT
			case "top-center":
				return TOP
			case "bottom-left":
				return BOTTOM | LEFT
			case "bottom-center":
				return BOTTOM
			case "bottom-right":
				return BOTTOM | RIGHT
			case "top-right":
			default:
				return TOP | RIGHT
		}
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

				const hexadecimal = name[1]?.toLowerCase() === "x"
				const code_point = Number.parseInt(
					name.slice(hexadecimal ? 2 : 1),
					hexadecimal ? 16 : 10,
				)
				const valid_control =
					code_point === 9 || code_point === 10 || code_point === 13
				if (
					!Number.isInteger(code_point) ||
					code_point > 0x10ffff ||
					(code_point < 0x20 && !valid_control)
				)
					return "\uFFFD"

				return String.fromCodePoint(code_point)
			},
		)
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

	function Content({ notification, image_path, persistent, avatar = false }: content_props) {
		const body = body_text(notification.body)
		let image_size = persistent ? 260 : 75
		let image_height = persistent ? 160 : 75
		if (avatar) {
			image_size = 48
			image_height = 48
		}
		const preview_size = options.scale.as((scale) =>
			Math.round((image_size * scale) / 100))
		const preview_height = options.scale.as((scale) =>
			Math.round((image_height * scale) / 100))
		const preview_texture = image_path
			? createComputed(() => create_texture_accessor(image_path, preview_size(), "contain"))
			: null
		const preview_paintable = preview_texture
			? createComputed(() => preview_texture()())
			: null
		const fitted_height = preview_paintable
			? createComputed(() => {
				const texture = preview_paintable()
				if (!texture) return preview_height()
				const ratio = Math.min(preview_size() / texture.get_width(),
					preview_height() / texture.get_height())
				return Math.max(1, Math.round(texture.get_height() * ratio))
			}) : null
		const preview = preview_paintable && (
			<Gtk.Picture
				class={avatar ? "avatar" : "preview"}
				tooltipText={image_path ?? undefined}
				widthRequest={avatar ? preview_size : undefined}
				heightRequest={avatar ? preview_height : fitted_height!}
				halign={START}
				valign={CENTER}
				visible={preview_paintable.as((texture) => texture !== null)}
				paintable={preview_paintable as unknown as Accessor<Gdk.Paintable>}
				canShrink
			/>
		)

		return (
			<box class={`content${persistent ? " history" : ""}`} orientation={persistent && !avatar ? VERTICAL : HORIZONTAL}>
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
				revealChild={createComputed(() => show_actions() && actions.some(({ id }) => notification_action_available(id)))}
				transitionDuration={options.transition.duration}
				transitionType={SWING_DOWN}
			>
				<box class={`actions ${vertical ? "vertical" : "horizontal"}`} orientation={vertical ? VERTICAL : HORIZONTAL}>
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

	function Notification({
		entry: notification,
		state,
		persistent,
		transition_type,
	}: notification_props) {
		const [show_actions, set_show_actions] = createState(false)

		const image_value = notification.get_image()
		const image_path =
			image_value && classify_image_uri(image_value) !== "unknown"
				? image_value
				: null
		const cached_image_prefix = `${GLib.get_user_cache_dir()}/astal/notifd/`
		const avatar = !!image_path &&
			image_path.startsWith(cached_image_prefix) && /^\d+\.png$/.test(image_path.slice(cached_image_prefix.length)) &&
			notification.get_category()?.startsWith("im.") === true
		const app_icon = substitute_icon_name(
			notification.get_app_icon() ||
				(image_value && !image_path ? image_value : "") ||
				notification.get_desktop_entry() ||
				icons.fallback.notification,
			icons.fallback.notification,
		)
		const app_name = (
			notification.get_app_name() ||
			notification.get_desktop_entry() ||
			"Notification"
		).toUpperCase()
		let saved_path = ""
		if (notification.get_app_name() === "Screenshot" && notification.summary === "Screenshot taken")
			saved_path = `${env.paths.home}/Pictures/Screenshots/`
		else if (notification.get_app_name() === "Recorder" && notification.summary === "Recording saved")
			saved_path = `${env.paths.home}/Videos/Screencasting/`
		const archived_capture = persistent && notification.time < notification_manager.session_start &&
			!!saved_path && (notification.body.startsWith(saved_path) || image_value?.startsWith(saved_path) === true)
		const valid_actions = archived_capture ? [] : notification
			.get_actions()
			.filter((a) => a.label?.trim())
			.map((a) => ({ label: a.label!, id: a.id }))

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
						app_icon={app_icon}
						app_name={app_name}
						show_actions={show_actions}
						on_dismiss={state.dismiss}
					/>
					<Content notification={notification} image_path={image_path} persistent={persistent} avatar={avatar} />
					<Actions
						actions={valid_actions}
						show_actions={show_actions}
						on_action_click={state.on_action_click}
					/>
				</box>
			</revealer>
		)
	}

	function NotificationList({
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

		function remove(entry: list_entry) {
			const index = entries.indexOf(entry)
			if (index < 0) return
			entries.splice(index, 1)
			entry.dispose()
			on_count_changed?.(entries.length)
			if (entry.next && notification_daemon.get_notification(entry.next.id) === entry.next)
				show(entry.next)
			if (persistent) reconcile()
		}

		function reconcile() {
			if (!persistent) return
			const desired = notification_daemon.get_notifications()
				.filter(accepts)
				.sort((left, right) => right.time - left.time)
				.slice(0, list_limit)
			for (const entry of [...entries])
				if (!desired.some((notification) => notification.id === entry.notification.id))
					entry.state.close()
			for (const notification of desired) show(notification)
		}

		function mount(notification: AstalNotifd.Notification) {
			let index = entries.findIndex(
				(entry) => entry.notification.time <= notification.time,
			)
			if (index < 0) index = entries.length

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

			container.insert_child_after(
				entry.widget,
				index > 0 ? entries[index - 1].widget : null,
			)
			entries.splice(index, 0, entry)
			on_count_changed?.(entries.length)

			const open = entries.filter((other) => !other.state.is_closing())
			if (open.length > list_limit) open[open.length - 1].state.close()
		}

		function show(notification: AstalNotifd.Notification) {
			const entry = entries.find(
				(other) => other.notification.id === notification.id,
			)
			if (!accepts(notification)) {
				if (!entry) return
				entry.next = undefined
				entry.state.close()
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

		const notified_handler = notification_daemon.connect(
			"notified",
			(_, id: number) => {
				const notification = notification_daemon.get_notification(id)
				if (notification) show(notification)
			},
		)

		const resolved_handler = notification_daemon.connect(
			"resolved",
			(_, id: number) => {
				const entry = entries.find((other) => other.notification.id === id)
				if (!entry) {
					reconcile()
					return
				}
				entry.next = undefined
				entry.state.close()
			},
		)
		const blacklist_unsubscribe = options.notifications.blacklist.subscribe(() => {
			for (const entry of [...entries])
				if (notification_manager.is_blacklisted(entry.notification))
					entry.state.close()
			reconcile()
		})

		if (persistent) reconcile()
		else for (const notification of notification_daemon.get_notifications())
			if (notification.time >= notification_manager.session_start) show(notification)

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
