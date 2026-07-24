// Shows notification popups and history with timed animations.

import { Accessor, createState, createBinding, createComputed, createRoot, For, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import AstalNotifd from "gi://AstalNotifd"
import Pango from "gi://Pango"

import { PanelButton } from "../PanelButton"

import env from "$lib/env"
import icons, { substituteIconName } from "$lib/icons"
import { timeAgo } from "$lib/time"
import { toggleWindow } from "widget/Windowing/WindowControl"
import { createSquareTextureAccessor, isInlineImageData } from "$lib/textures"
import { notificationManager } from "$service/notifications"
import { notificationDaemon } from "$service/astal"
import { createEntryLifecycle, type EntryIndex, type VisibilityController } from "./EntryLifecycle"

import options from "options"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { WORD } = Gtk.WrapMode
const { SLIDE_DOWN, SLIDE_UP, SWING_RIGHT, SWING_DOWN } = Gtk.RevealerTransitionType
const { EllipsizeMode } = Pango
const { NORMAL } = Astal.Exclusivity
const { TOP, RIGHT, LEFT, BOTTOM } = Astal.WindowAnchor
const POPUP_LIMIT = 50

export namespace Notifications {
	const previewSize = options.scale.as(scale => Math.round(75 * scale / 100))
	const popupWidth = options.scale.as(scale => Math.round(350 * scale / 100))

	type NotificationProps = {
		entry: AstalNotifd.Notification
		widthRequest?: Accessor<number> | number
		persistent: boolean
		index?: EntryIndex
		onExit?: () => void
		registerClose?: (close: () => void) => void
		transitionType?: Accessor<Gtk.RevealerTransitionType> | Gtk.RevealerTransitionType
	}

	type PopupEntry = {
		notification: AstalNotifd.Notification
		close?: () => void
		dispose?: () => void
		resolved: boolean
		replacement?: AstalNotifd.Notification
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
		actions: Array<{ label: string, id: string }>
		showActions: Accessor<boolean>
		onActionClick: (actionId: string) => void
	}

	const notifications = createBinding(notificationManager, "notifications")
	const dismissingAll = createBinding(notificationManager, "dismissingAll")

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

	function maxStaggerDelay() {
		const count = notifications.peek().length
		return count > 0 ? count * 50 + 100 : 0
	}

	function isPreviewImage(value: string | null): value is string {
		if (!value) return false
		return (
			value.startsWith("/")
			|| value.startsWith("file://")
			|| value.startsWith("http://")
			|| value.startsWith("https://")
			|| isInlineImageData(value)
		)
	}

	function createVisibilityController(initial = false): VisibilityController {
		const [value, setValue] = createState(initial)

		return {
			value,
			show: () => setValue(true),
			hide: () => setValue(false),
		}
	}

	const URGENCY_CLASS: Record<number, string> = {
		[AstalNotifd.Urgency.LOW]: "low",
		[AstalNotifd.Urgency.CRITICAL]: "critical",
	}

	function urgency(n: AstalNotifd.Notification): string {
		return URGENCY_CLASS[n.urgency] ?? "normal"
	}


	function Header({ notification, appIcon, appName, showActions, onDismiss }: HeaderProps) {
		return (
			<box class="header">
				<image class="app-icon" iconName={appIcon} useFallback />
				<label class="app-name" halign={START} maxWidthChars={24} ellipsize={EllipsizeMode.END} useMarkup label={appName} />
				<label class="time" halign={END} hexpand label={env.uptime(() => timeAgo(notification.time))} />
				<revealer revealChild={showActions} transitionDuration={options.transition.duration} transitionType={SWING_RIGHT}>
					<button class="close-button" onClicked={onDismiss}>
						<image iconName={icons.ui.close} halign={CENTER} valign={CENTER} useFallback />
					</button>
				</revealer>
			</box>
		)
	}

	function Content({ notification, imagePath }: ContentProps) {
		const previewPaintable = imagePath
			? createComputed(() => createSquareTextureAccessor(imagePath, previewSize())())
			: null

		return (
			<box class="content">
				{previewPaintable && (
					<box class="image-preview" widthRequest={previewSize} heightRequest={previewSize}>
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
					<label class="summary" wrap wrapMode={WORD} maxWidthChars={28} halign={START} label={notification.summary} />
					{notification.body && (
						<label class="body" wrap wrapMode={WORD} maxWidthChars={28} halign={START} useMarkup label={notification.body} />
					)}
				</box>
			</box>
		)
	}

	function Actions({ actions, showActions, onActionClick }: ActionsProps) {
		if (actions.length === 0)
			return <box visible={false} />

		return (
			<revealer revealChild={showActions} transitionDuration={options.transition.duration} transitionType={SWING_DOWN}>
				<box class="actions horizontal">
					{actions.map(({ label, id }) => (
						<button hexpand label={label} onClicked={() => onActionClick(id)} />
					))}
				</box>
			</revealer>
		)
	}

	function Notification({ entry: notification, widthRequest, persistent, index, onExit, registerClose, transitionType = SLIDE_DOWN }: NotificationProps) {
		const visibility = createVisibilityController(false)
		const [showActions, setShowActions] = createState(false)

		const state = createEntryLifecycle({
			notification,
			persistent,
			index,
			visibility,
			dismissingAll,
			onExit,
		})
		registerClose?.(state.close)

		const dismissSub = dismissingAll.subscribe(state.onDismissAllChanged)

		onCleanup(() => {
			dismissSub()
			state.cleanup()
		})

		const imageValue = notification.get_image()
		const imagePath = isPreviewImage(imageValue) ? imageValue : null
		const appIcon = substituteIconName(
			notification.get_app_icon() || (imageValue && !imagePath ? imageValue : "") || notification.get_desktop_entry() || icons.fallback.notification,
			icons.fallback.notification,
		)
		const appName = (notification.get_app_name() || notification.get_desktop_entry() || "Notification").toUpperCase()
		const validActions = notification
			.get_actions()
			.filter(a => a.label?.trim())
			.map(a => ({ label: a.label!, id: a.id }))

		return (
			<revealer
				revealChild={visibility.value}
				transitionDuration={options.transition.duration}
				transitionType={transitionType}
				onMap={state.onMap}
				onNotifyChildRevealed={(self) => {
					state.onHidden(!self.get_child_revealed() && !self.get_reveal_child())
				}}
			>
				<box class={`notification ${urgency(notification)}`} orientation={VERTICAL} widthRequest={widthRequest}>
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
					<Actions actions={validActions} showActions={showActions} onActionClick={state.onActionClick} />
				</box>
			</revealer>
		)
	}

	export function animateDismissAll() {
		notificationManager.dismissAllAfterTransitions(options.transition.duration.peek(), maxStaggerDelay())
	}

	export function Stack({ class: className }: { class?: string }) {
		return (
			<box class={className || "notifications-stack"} orientation={VERTICAL} valign={START}>
				<For each={notifications}>{(n, i) => <Notification entry={n} persistent index={i} />}</For>
			</box>
		)
	}

	function PopupStack() {
		const entries = new Map<number, PopupEntry>()
		const pending = new Map<number, AstalNotifd.Notification>()
		const container = <box class="notifications-stack" orientation={VERTICAL} valign={START} /> as Gtk.Box
		const transitionType = options.notifications.position.as(position => position.startsWith("bottom") ? SLIDE_UP : SLIDE_DOWN)

		function remove(entry: PopupEntry) {
			if (entries.get(entry.notification.id) !== entry) return
			entries.delete(entry.notification.id)
			entry.dispose?.()
			if (entry.replacement && !entry.resolved)
				mount(entry.replacement)
			fillPending()
		}

		function mount(notification: AstalNotifd.Notification) {
			if (entries.size >= POPUP_LIMIT) return
			const entry: PopupEntry = { notification, resolved: false }
			entries.set(notification.id, entry)
			entry.dispose = createRoot(dispose => {
				const widget = <Notification
					entry={notification}
					persistent={false}
					index={entries.size - 1}
					transitionType={transitionType}
					onExit={() => remove(entry)}
					registerClose={close => {
						entry.close = close
						if (entry.resolved || entry.replacement) close()
					}}
				/> as Gtk.Widget
				container.prepend(widget)
				return () => {
					container.remove(widget)
					dispose()
				}
			})
		}

		function fillPending() {
			while (entries.size < POPUP_LIMIT && pending.size > 0) {
				const next = pending.entries().next().value as [number, AstalNotifd.Notification]
				pending.delete(next[0])
				mount(next[1])
			}
		}

		function enqueue(notification: AstalNotifd.Notification) {
			if (notificationManager.doNotDisturb) return
			const blacklist = options.notifications.blacklist.peek() || []
			if (blacklist.includes(notification.get_app_name() || notification.get_desktop_entry())) return

			const existing = entries.get(notification.id)
			if (existing) {
				existing.replacement = notification
				existing.close?.()
				return
			}
			if (entries.size < POPUP_LIMIT) {
				mount(notification)
				return
			}

			pending.delete(notification.id)
			pending.set(notification.id, notification)
			while (pending.size > POPUP_LIMIT)
				pending.delete(pending.keys().next().value!)
			for (const entry of entries.values()) entry.close?.()
		}

		const notifiedHandler = notificationDaemon.connect("notified", (_, id: number) => {
			const notification = notificationDaemon.get_notification(id)
			if (notification) enqueue(notification)
		})

		const resolvedHandler = notificationDaemon.connect("resolved", (_, id: number) => {
			pending.delete(id)
			const entry = entries.get(id)
			if (!entry) return
			entry.resolved = true
			entry.close?.()
		})

		for (const notification of notificationDaemon.get_notifications())
			if (notification.time >= notificationManager.sessionStart) enqueue(notification)

		onCleanup(() => {
			notificationDaemon.disconnect(notifiedHandler)
			notificationDaemon.disconnect(resolvedHandler)
			for (const entry of entries.values()) entry.dispose?.()
			entries.clear()
			pending.clear()
		})

		return container
	}

	export function Button() {
		return (
			<PanelButton class="messages" visible={notifications.as(v => v.length > 0)} tooltipText={notifications.as(v => `${v.length} pending notification${v.length === 1 ? "" : "s"}`)} onClicked={() => toggleWindow("datemenu")}>
				<image iconName={icons.notifications.message} useFallback />
			</PanelButton>
		)
	}

	export function Window() {
		const anchor = createComputed(() => anchorForPosition(options.notifications.position()))
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
				<PopupStack />
			</window>
		)
	}
}
