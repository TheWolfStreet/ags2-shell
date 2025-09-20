import { Accessor, createState, For, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import { PanelButton } from "./PanelButton"

import env from "$lib/env"
import { notifd } from "$lib/services"
import icons from "$lib/icons"
import { fileExists, textureFromFile, toggleWindow } from "$lib/utils"

import options from "options"

const { COVER } = Gtk.ContentFit
const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { SWING_RIGHT, SWING_DOWN, SLIDE_DOWN } = Gtk.RevealerTransitionType
const { EXCLUSIVE } = Astal.Exclusivity
const { TOP, RIGHT } = Astal.WindowAnchor

const MAX_NOTIFICATIONS = 50

// TODO: Refactor
export namespace Notifications {
	const [_current, set_current] = createState<Array<AstalNotifd.Notification>>([])
	export const current = _current

	const [hovered, setHovered] = createState(false)
	const [dismiss, setDismiss] = createState(false)

	const [hidingNotifications, setHidingNotifications] = createState<Set<number>>(new Set())
	const [autoHiddenNotifications, setAutoHiddenNotifications] = createState<Set<number>>(new Set())

	const notifyHandler = notifd.connect("notified", (_, id, replaced) => {
		const notification = notifd.get_notification(id)
		const blacklist = options.notifications.blacklist.get() || []
		const appName = notification.get_app_name() || notification.get_desktop_entry()

		if (blacklist.includes(appName)) return

		if (replaced && _current.get().some((n) => n.id === id)) {
			set_current(ns => ns.map(n => (n.id === id ? notification : n)))
		} else {
			set_current(ns => [notification, ...ns].slice(0, MAX_NOTIFICATIONS))
		}
	})

	export function dismissAll() {
		setDismiss(true)
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.transition.duration.get(), () => {
			setDismiss(false)
			set_current([])
			setHidingNotifications(new Set())
			setAutoHiddenNotifications(new Set())
			return GLib.SOURCE_REMOVE
		})
	}

	function hideNotification(notification: AstalNotifd.Notification, onComplete?: () => void) {
		setHidingNotifications(prev => new Set([...prev, notification.id]))

		GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.transition.duration.get(), () => {
			set_current(ns => ns.filter(n => n.id !== notification.id))
			setHidingNotifications(prev => {
				const newSet = new Set(prev)
				newSet.delete(notification.id)
				return newSet
			})
			return GLib.SOURCE_REMOVE
		})

		onComplete?.()
	}

	function autoHideNotification(notification: AstalNotifd.Notification) {
		setAutoHiddenNotifications(prev => new Set([...prev, notification.id]))
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

	function Entry({ entry: notification, widthRequest, persistent }: { entry: AstalNotifd.Notification, widthRequest?: Accessor<number> | number, persistent?: boolean }) {
		const [reveal, set_reveal] = createState(false)
		const [revealActions, set_revealActions] = createState(false)

		let closed = false
		let wasShown = false
		let dismissTimer: number | undefined

		const clearTimer = () => {
			if (dismissTimer) {
				GLib.source_remove(dismissTimer)
				dismissTimer = undefined
			}
		}

		const remove = () => {
			clearTimer()
			notification.dismiss()
		}

		const startAutoHide = () => {
			if (persistent) return
			clearTimer()
			dismissTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.notifications.dismiss.get(), () => {
				if (!hovered.get()) {
					set_reveal(false)
				}
				dismissTimer = undefined
				return GLib.SOURCE_REMOVE
			})
		}

		const handleDismiss = () => {
			if (dismiss.get()) {
				set_reveal(false)
				GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.notifications.dismiss.get(), () => {
					notification.dismiss()
					return GLib.SOURCE_REMOVE
				})
			}
		}

		const hidingUnsub = hidingNotifications.subscribe(() => {
			if (hidingNotifications.get().has(notification.id)) {
				set_reveal(false)
			}
		})

		const autoHiddenUnsub = autoHiddenNotifications.subscribe(() => {
			if (!persistent && autoHiddenNotifications.get().has(notification.id)) {
				set_reveal(false)
			}
		})

		const onEnter = () => {
			if (closed) return
			set_revealActions(true)
			if (!persistent) {
				setHovered(true)
				clearTimer()
			}
		}

		const onLeave = () => {
			if (closed) return
			set_revealActions(false)
			if (!persistent) setHovered(false)
		}

		const onReveal = (self: Gtk.Revealer) => {
			if (!self.get_reveal_child() && closed) {
				remove()
			} else if (!self.get_reveal_child() && !persistent && autoHiddenNotifications.get().has(notification.id)) {
				autoHideNotification(notification)
			} else {
				startAutoHide()
			}
		}

		const onClose = () => {
			closed = true
			hideNotification(notification, () => notification.dismiss())
		}

		const onActionClick = (actionId: string) => {
			closed = true
			hideNotification(notification, () => notification.invoke(actionId))
		}

		const dismissUnsub = dismiss.subscribe(handleDismiss)
		const hoveredUnsub = hovered.subscribe(() => {
			if (!hovered.get() && !persistent && !closed) startAutoHide()
		})

		onCleanup(() => {
			dismissUnsub()
			hoveredUnsub()
			hidingUnsub()
			autoHiddenUnsub()
			clearTimer()
		})

		const appIcon = notification.appIcon || notification.desktopEntry || icons.fallback.notification
		const appName = (notification.appName || notification.desktopEntry || "Notification").toUpperCase()
		const hasImage = notification.get_image() && fileExists(notification.get_image())
		const validActions = notification.get_actions().filter(a => a.label?.trim())

		return (
			<revealer
				revealChild={reveal}
				transitionDuration={options.transition.duration}
				transitionType={SLIDE_DOWN}
				onNotifyChildRevealed={onReveal}
				onMap={() => {
					if (!wasShown && (!notifd.get_dont_disturb() || persistent)) {
						if (!persistent && autoHiddenNotifications.get().has(notification.id)) {
							return
						}
						set_reveal(true)
						wasShown = true
					}
				}}
			>
				<box class={`notification ${urgency(notification)}`} orientation={VERTICAL} widthRequest={widthRequest}>
					<Gtk.EventControllerMotion onEnter={onEnter} onLeave={onLeave} />
					<box class="header">
						<image class="app-icon" iconName={appIcon} useFallback />
						<label class="app-name" halign={START} maxWidthChars={24} ellipsize={Pango.EllipsizeMode.END} useMarkup label={appName} />
						<label class="time" halign={END} hexpand label={env.uptime(() => formatTime(notification.time))} />
						<revealer revealChild={revealActions} transitionDuration={options.transition.duration} transitionType={SWING_RIGHT}>
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
						<revealer revealChild={revealActions} transitionType={SWING_DOWN} transitionDuration={options.transition.duration}>
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

	export function Stack({ persistent = false }: { persistent?: boolean }) {
		return (
			<box class="notifications-stack" orientation={VERTICAL} valign={START}>
				<For each={current}>{(n) => <Entry entry={n} persistent={persistent} />}</For>
			</box>
		)
	}

	export function Button() {
		return (
			<PanelButton class="messages" visible={current.as(v => v.length > 0)} tooltipText={current.as(v => `${v.length} pending notification${v.length === 1 ? '' : 's'}`)} onClicked={() => toggleWindow("datemenu")}>
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
