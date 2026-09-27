// Shows notification popups and history with timed animations.

import {
	Accessor,
	createState,
	createBinding,
	createComputed,
	createRoot,
	onCleanup,
} from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { createPoll, timeout } from "ags/time"

import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import { PanelButton } from "../PanelButton"

import icons, { substituteIconName } from "$lib/icons"
import { classifyImageUri, createSquareTextureAccessor } from "$lib/textures"
import { notificationDaemon } from "$lib/notifications"
import { notificationManager } from "$service/notifications"
import { createEntryLifecycle, type EntryLifecycle } from "./EntryLifecycle"

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
			anchorForPosition(options.notifications.position()),
		)
		return (
			<window
				visible
				resizable={false}
				heightRequest={1}
				widthRequest={popupWidth}
				name="notifications"
				class="notifications"
				application={app}
				exclusivity={NORMAL}
				anchor={anchor}
			>
				<NotificationList
					class="notifications-stack"
					persistent={false}
					transitionType={options.notifications.position.as((position) =>
						position.startsWith("bottom") ? SLIDE_UP : SLIDE_DOWN,
					)}
				/>
			</window>
		)
	}

	export function animateDismissAll() {
		const all = notificationDaemon
			.get_notifications()
			.sort((left, right) => right.time - left.time)
		all.forEach((notification, index) => {
			timeout(index * 50 + Math.random() * 100, () => {
				if (notificationDaemon.get_notification(notification.id) === notification)
					notification.dismiss()
			})
		})
	}

	export function Stack({ class: className }: { class: string }) {
		return <NotificationList class={className} persistent />
	}

	const previewSize = options.scale.as((scale) =>
		Math.round((75 * scale) / 100),
	)
	const popupWidth = options.scale.as((scale) =>
		Math.round((350 * scale) / 100),
	)

	type TransitionType =
		| Accessor<Gtk.RevealerTransitionType>
		| Gtk.RevealerTransitionType

	type NotificationProps = {
		entry: AstalNotifd.Notification
		state: EntryLifecycle
		transitionType: TransitionType
	}

	type ListEntry = {
		notification: AstalNotifd.Notification
		state: EntryLifecycle
		widget: Gtk.Widget
		dispose: () => void
		next?: AstalNotifd.Notification
	}

	type HeaderProps = {
		notification: AstalNotifd.Notification
		appIcon: string
		appName: string
		showActions: Accessor<boolean>
		onDismiss: () => void
	}

	type ContentProps = {
		notification: AstalNotifd.Notification
		imagePath: string | null
	}

	type ActionsProps = {
		actions: Array<{ label: string; id: string }>
		showActions: Accessor<boolean>
		onActionClick: (actionId: string) => void
	}

	const notifications = createBinding(notificationManager, "notifications")
	const minuteTicker = createPoll(0, 60_000, (tick) => tick + 1)

	function anchorForPosition(position: string) {
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

	const URGENCY_CLASS: Record<number, string> = {
		[AstalNotifd.Urgency.LOW]: "low",
		[AstalNotifd.Urgency.CRITICAL]: "critical",
	}

	function urgency(n: AstalNotifd.Notification): string {
		return URGENCY_CLASS[n.urgency] ?? "normal"
	}

	function decodeMarkupEntities(text: string) {
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
				const codePoint = Number.parseInt(
					name.slice(hexadecimal ? 2 : 1),
					hexadecimal ? 16 : 10,
				)
				const validControl =
					codePoint === 9 || codePoint === 10 || codePoint === 13
				if (
					!Number.isInteger(codePoint) ||
					codePoint > 0x10ffff ||
					(codePoint < 0x20 && !validControl)
				)
					return "\uFFFD"

				return String.fromCodePoint(codePoint)
			},
		)
	}

	function bodyText(body: string) {
		return decodeMarkupEntities(
			body
				.replace(
					/<img\b[^>]*>/gi,
					(tag) => tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] ?? "",
				)
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<[^>]*>/g, ""),
		)
	}

	function timeAgo(time: number) {
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
		appIcon,
		appName,
		showActions,
		onDismiss,
	}: HeaderProps) {
		return (
			<box class="header">
				<image class="app-icon" iconName={appIcon} useFallback />
				<label
					class="app-name"
					halign={START}
					maxWidthChars={24}
					ellipsize={EllipsizeMode.END}
					label={appName}
				/>
				<label
					class="time"
					halign={END}
					hexpand
					label={minuteTicker(() => timeAgo(notification.time))}
				/>
				<revealer
					revealChild={showActions}
					transitionDuration={options.transition.duration}
					transitionType={SWING_RIGHT}
				>
					<button class="close-button" onClicked={onDismiss}>
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

	function Content({ notification, imagePath }: ContentProps) {
		const previewPaintable = imagePath
			? createComputed(() =>
					createSquareTextureAccessor(imagePath, previewSize())(),
				)
			: null

		return (
			<box class="content">
				{previewPaintable && (
					<box
						class="image-preview"
						widthRequest={previewSize}
						heightRequest={previewSize}
					>
						<Gtk.Picture
							class="preview"
							widthRequest={previewSize}
							heightRequest={previewSize}
							halign={CENTER}
							valign={CENTER}
							paintable={previewPaintable as unknown as Accessor<Gdk.Paintable>}
							canShrink
						/>
					</box>
				)}
				<box orientation={VERTICAL}>
					<label
						class="summary"
						wrap
						wrapMode={WORD}
						maxWidthChars={28}
						halign={START}
						label={notification.summary}
					/>
					{notification.body && (
						<label
							class="body"
							wrap
							wrapMode={WORD}
							maxWidthChars={28}
							halign={START}
							label={bodyText(notification.body)}
						/>
					)}
				</box>
			</box>
		)
	}

	function Actions({ actions, showActions, onActionClick }: ActionsProps) {
		if (actions.length === 0) return <box visible={false} />

		return (
			<revealer
				revealChild={showActions}
				transitionDuration={options.transition.duration}
				transitionType={SWING_DOWN}
			>
				<box class="actions horizontal">
					{actions.map(({ label, id }) => (
						<button hexpand label={label} onClicked={() => onActionClick(id)} />
					))}
				</box>
			</revealer>
		)
	}

	function Notification({
		entry: notification,
		state,
		transitionType,
	}: NotificationProps) {
		const [showActions, setShowActions] = createState(false)

		const imageValue = notification.get_image()
		const imagePath =
			imageValue && classifyImageUri(imageValue) !== "unknown"
				? imageValue
				: null
		const appIcon = substituteIconName(
			notification.get_app_icon() ||
				(imageValue && !imagePath ? imageValue : "") ||
				notification.get_desktop_entry() ||
				icons.fallback.notification,
			icons.fallback.notification,
		)
		const appName = (
			notification.get_app_name() ||
			notification.get_desktop_entry() ||
			"Notification"
		).toUpperCase()
		const validActions = notification
			.get_actions()
			.filter((a) => a.label?.trim())
			.map((a) => ({ label: a.label!, id: a.id }))

		return (
			<revealer
				revealChild={state.visible}
				transitionDuration={options.transition.duration}
				transitionType={transitionType}
				onMap={state.onMap}
				onNotifyChildRevealed={(self) =>
					state.onRevealedChanged(self.get_child_revealed())
				}
			>
				<box
					class={`notification ${urgency(notification)}`}
					orientation={VERTICAL}
				>
					<Gtk.EventControllerMotion
						onEnter={() => {
							state.keepAlive()
							setShowActions(true)
						}}
						onMotion={state.keepAlive}
						onLeave={() => setShowActions(false)}
					/>
					<Header
						notification={notification}
						appIcon={appIcon}
						appName={appName}
						showActions={showActions}
						onDismiss={state.dismiss}
					/>
					<Content notification={notification} imagePath={imagePath} />
					<Actions
						actions={validActions}
						showActions={showActions}
						onActionClick={state.onActionClick}
					/>
				</box>
			</revealer>
		)
	}

	function NotificationList({
		class: className,
		persistent,
		transitionType = SLIDE_DOWN,
	}: {
		class: string
		persistent: boolean
		transitionType?: TransitionType
	}) {
		const entries: ListEntry[] = []
		const container = (
			<box class={className} orientation={VERTICAL} valign={START} />
		) as Gtk.Box

		function accepts(notification: AstalNotifd.Notification) {
			if (notificationManager.isBlacklisted(notification)) return false
			return persistent || !notificationManager.doNotDisturb
		}

		function remove(entry: ListEntry) {
			const index = entries.indexOf(entry)
			if (index < 0) return
			entries.splice(index, 1)
			entry.dispose()
			if (entry.next) show(entry.next)
		}

		function mount(notification: AstalNotifd.Notification) {
			let index = entries.findIndex(
				(entry) => entry.notification.time <= notification.time,
			)
			if (index < 0) index = entries.length

			const entry: ListEntry = createRoot((dispose) => {
				const state = createEntryLifecycle({
					notification,
					persistent,
					onExit: () => remove(entry),
				})
				onCleanup(state.cleanup)
				const widget = (
					<Notification
						entry={notification}
						state={state}
						transitionType={transitionType}
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

			const open = entries.filter((other) => !other.state.isClosing())
			if (open.length > LIST_LIMIT) open[open.length - 1].state.close()
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
			if (entry.notification === notification && !entry.state.isClosing())
				return
			entry.next = notification
			entry.state.close()
		}

		const notifiedHandler = notificationDaemon.connect(
			"notified",
			(_, id: number) => {
				const notification = notificationDaemon.get_notification(id)
				if (notification) show(notification)
			},
		)

		const resolvedHandler = notificationDaemon.connect(
			"resolved",
			(_, id: number) => {
				const entry = entries.find((other) => other.notification.id === id)
				if (!entry) return
				entry.next = undefined
				entry.state.close()
			},
		)

		const blacklistUnsub = options.notifications.blacklist.subscribe(() => {
			for (const entry of [...entries])
				if (notificationManager.isBlacklisted(entry.notification))
					entry.state.close()
			if (persistent)
				for (const notification of notificationDaemon.get_notifications())
					show(notification)
		})

		for (const notification of notificationDaemon.get_notifications())
			if (persistent || notification.time >= notificationManager.sessionStart)
				show(notification)

		onCleanup(() => {
			notificationDaemon.disconnect(notifiedHandler)
			notificationDaemon.disconnect(resolvedHandler)
			blacklistUnsub()
			for (const entry of entries.splice(0)) entry.dispose()
		})

		return container
	}

	const { START, CENTER, END } = Gtk.Align
	const { VERTICAL } = Gtk.Orientation
	const { WORD } = Gtk.WrapMode
	const { SLIDE_DOWN, SLIDE_UP, SWING_RIGHT, SWING_DOWN } =
		Gtk.RevealerTransitionType
	const { EllipsizeMode } = Pango
	const { NORMAL } = Astal.Exclusivity
	const { TOP, RIGHT, LEFT, BOTTOM } = Astal.WindowAnchor
	const LIST_LIMIT = 50
}
