import { Accessor, createState, For, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import { PanelButton } from "../PanelButton"

import env from "$lib/env"
import { notifd } from "$lib/services"
import icons from "$lib/icons"
import { fileExists, textureFromFile, toggleWindow } from "$lib/utils"

import options from "options"

const { COVER } = Gtk.ContentFit
const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { SLIDE_DOWN, SWING_RIGHT, SWING_DOWN } = Gtk.RevealerTransitionType
const { EXCLUSIVE } = Astal.Exclusivity
const { TOP, RIGHT } = Astal.WindowAnchor

const MAX_NOTIFICATIONS = 50

export namespace Notifications {
	const [notifications, set_notifications] = createState<Array<AstalNotifd.Notification>>([])
	const [dismissingAll, set_dismissingAll] = createState(false)
	const [popupHovered, set_popupHovered] = createState(false)

	export const current = notifications

	const notifyHandler = notifd.connect("notified", (_, id, replaced) => {
		const notification = notifd.get_notification(id)
		if (!notification) return

		const blacklist = options.notifications.blacklist.peek() || []
		const appName = notification.get_app_name() || notification.get_desktop_entry()

		if (blacklist.includes(appName)) return

		if (replaced && notifications.peek().some(n => n.id === id)) {
			set_notifications(ns => ns.map(n => n.id === id ? notification : n))
		} else {
			set_notifications(ns => [notification, ...ns].slice(0, MAX_NOTIFICATIONS))
		}
	})

	export function dismissAll() {
		set_dismissingAll(true)
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.transition.duration.peek(), () => {
			set_dismissingAll(false)
			set_notifications([])
			return GLib.SOURCE_REMOVE
		})
	}

	function removeNotification(id: number) {
		set_notifications(ns => ns.filter(n => n.id !== id))
	}

	export function formatTime(time: number) {
		const now = GLib.DateTime.new_now_local()
		const then = GLib.DateTime.new_from_unix_local(time)
		if (!then) return ""
		const diff = now.to_unix() - then.to_unix()
		if (diff < 60) return "now"
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
		return `${Math.floor(diff / 86400)}d ago`
	}

	export function urgency(n: AstalNotifd.Notification): string {
		const { LOW, CRITICAL } = AstalNotifd.Urgency
		switch (n.urgency) {
			case LOW: return "low"
			case CRITICAL: return "critical"
			default: return "normal"
		}
	}

	function Entry({ entry: notification, widthRequest, persistent }: {
		entry: AstalNotifd.Notification,
		widthRequest?: Accessor<number> | number,
		persistent?: boolean
	}) {
		const [visible, set_visible] = createState(false)
		const [showActions, set_showActions] = createState(false)

		let autoHideTimer: number | undefined
		let mounted = false

		const clearTimer = () => {
			if (autoHideTimer) {
				GLib.source_remove(autoHideTimer)
				autoHideTimer = undefined
			}
		}

		const scheduleAutoHide = () => {
			if (persistent) return
			clearTimer()
			autoHideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.notifications.dismiss.peek(), () => {
				if (!popupHovered.peek()) {
					set_visible(false)
				}
				autoHideTimer = undefined
				return GLib.SOURCE_REMOVE
			})
		}

		let pendingAction: (() => void) | undefined

		const onClose = () => {
			clearTimer()
			pendingAction = () => {
				removeNotification(notification.id)
				notification.dismiss()
			}
			set_visible(false)
		}

		const onActionClick = (actionId: string) => {
			clearTimer()
			pendingAction = () => {
				removeNotification(notification.id)
				notification.invoke(actionId)
			}
			set_visible(false)
		}

		const dismissSub = dismissingAll.subscribe(() => {
			if (dismissingAll.peek()) set_visible(false)
		})

		const hoverSub = popupHovered.subscribe(() => {
			if (!persistent) {
				if (popupHovered.peek()) {
					clearTimer()
				} else if (visible.peek()) {
					scheduleAutoHide()
				}
			}
		})

		onCleanup(() => {
			dismissSub()
			hoverSub()
			clearTimer()
		})

		const appIcon = notification.appIcon || notification.desktopEntry || icons.fallback.notification
		const appName = (notification.appName || notification.desktopEntry || "Notification").toUpperCase()
		const hasImage = notification.get_image() && fileExists(notification.get_image())
		const validActions = notification.get_actions().filter(a => a.label?.trim())

		return (
			<revealer
				revealChild={visible}
				transitionDuration={options.transition.duration}
				transitionType={SLIDE_DOWN}
				onMap={() => {
					if (!mounted && (!notifd.get_dont_disturb() || persistent)) {
						set_visible(true)
						mounted = true
						if (!persistent) scheduleAutoHide()
					}
				}}
				onNotifyChildRevealed={(self) => {
					if (!self.get_reveal_child() && pendingAction) {
						pendingAction()
						pendingAction = undefined
					}
				}}
			>
				<box class={`notification ${urgency(notification)}`} orientation={VERTICAL} widthRequest={widthRequest}>
					<Gtk.EventControllerMotion
						onEnter={() => {
							if (!persistent) set_popupHovered(true)
							set_showActions(true)
						}}
						onLeave={() => {
							if (!persistent) set_popupHovered(false)
							set_showActions(false)
						}}
					/>
					<box class="header">
						<image class="app-icon" iconName={appIcon} useFallback />
						<label class="app-name" halign={START} maxWidthChars={24} ellipsize={Pango.EllipsizeMode.END} useMarkup label={appName} />
						<label class="time" halign={END} hexpand label={env.uptime(() => formatTime(notification.time))} />
						<revealer revealChild={showActions} transitionDuration={options.transition.duration} transitionType={SWING_RIGHT}>
							<button class="close-button" onClicked={onClose}>
								<image iconName={icons.ui.close} halign={CENTER} valign={CENTER} useFallback />
							</button>
						</revealer>
					</box>

					<box class="content">
						{hasImage && (
							<Gtk.Picture class="icon" contentFit={COVER} canShrink={false} paintable={textureFromFile(notification.get_image(), 75, 75) as Gdk.Paintable} />
						)}
						<box orientation={VERTICAL}>
							<label class="summary" wrap wrapMode={Gtk.WrapMode.WORD} maxWidthChars={28} halign={START} label={notification.summary} />
							{notification.body && (
								<label class="body" wrap wrapMode={Gtk.WrapMode.WORD} maxWidthChars={28} halign={START} useMarkup label={notification.body} />
							)}
						</box>
					</box>

					{validActions.length > 0 && (
						<revealer revealChild={showActions} transitionDuration={options.transition.duration} transitionType={SWING_DOWN}>
							<box class="actions horizontal">
								{validActions.map(({ label, id }) => (
									<button hexpand label={label} onClicked={() => onActionClick(id)} />
								))}
							</box>
						</revealer>
					)}
				</box>
			</revealer>
		)
	}

	export function Stack({ persistent = false, class: className }: { persistent?: boolean, class?: string }) {
		return (
			<box class={className || "notifications-stack"} orientation={VERTICAL} valign={START}>
				<For each={notifications}>{(n) => <Entry entry={n} persistent={persistent} />}</For>
			</box>
		)
	}

	export function Button() {
		return (
			<PanelButton class="messages" visible={notifications.as(v => v.length > 0)} tooltipText={notifications.as(v => `${v.length} pending notification${v.length === 1 ? '' : 's'}`)} onClicked={() => toggleWindow("datemenu")}>
				<image iconName={icons.notifications.message} useFallback />
			</PanelButton>
		)
	}

	export function Window() {
		onCleanup(() => notifd.disconnect(notifyHandler))
		return (
			<window visible resizable={false} heightRequest={1} widthRequest={350} name="notifications" class="notifications" application={app} exclusivity={EXCLUSIVE} anchor={TOP | RIGHT}>
				<Stack persistent={false} />
			</window>
		)
	}
}
