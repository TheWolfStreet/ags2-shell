import { Accessor, createState, createBinding, For, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { timeout, Timer } from "ags/time"

import AstalNotifd from "gi://AstalNotifd"
import Pango from "gi://Pango"

import { PanelButton } from "../PanelButton"

import env from "$lib/env"
import icons from "$lib/icons"
import { fileExists, formatTime, textureFromFile, toggleWindow } from "$lib/utils"
import { notifications as notificationManager } from "$lib/services"

import options from "options"

const { COVER } = Gtk.ContentFit
const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { SLIDE_DOWN, SWING_RIGHT, SWING_DOWN } = Gtk.RevealerTransitionType
const { EXCLUSIVE } = Astal.Exclusivity
const { TOP, RIGHT } = Astal.WindowAnchor

export namespace Notifications {
	const manager = notificationManager
	const notifications = createBinding(manager, "notifications")
	const dismissingAll = createBinding(manager, "dismissingAll")
	const popupHovered = createBinding(manager, "popupHovered")

	export const current = notifications

	function staggerDelay(index: number) {
		return index * 50 + Math.random() * 100
	}

	function maxStaggerDelay() {
		const count = notifications.peek().length
		return count > 0 ? count * 50 + 100 : 0
	}

	export function dismissAll() {
		manager.dismissAll(options.transition.duration.peek(), maxStaggerDelay())
	}

	export function urgency(n: AstalNotifd.Notification): string {
		const { LOW, CRITICAL } = AstalNotifd.Urgency
		switch (n.urgency) {
			case LOW: return "low"
			case CRITICAL: return "critical"
			default: return "normal"
		}
	}

	function Entry({ entry: notification, widthRequest, persistent, index }: {
		entry: AstalNotifd.Notification,
		widthRequest?: Accessor<number> | number,
		persistent?: boolean,
		index?: Accessor<number> | number
	}) {
		const [visible, set_visible] = createState(false)
		const [showActions, set_showActions] = createState(false)

		let autoHideTimer: Timer | undefined
		let mounted = false

		const clearTimer = () => {
			if (autoHideTimer) {
				autoHideTimer.cancel()
				autoHideTimer = undefined
			}
		}

		const getIndex = () => {
			if (index === undefined) return undefined
			return typeof index === "function" ? index.peek() : index
		}

		const scheduleAutoHide = (stagger: boolean = false) => {
			if (persistent) return
			clearTimer()
			const idx = getIndex()
			const delay = options.notifications.dismiss.peek() + (stagger && idx !== undefined ? staggerDelay(idx) : 0)
			autoHideTimer = timeout(delay, () => {
				if (!popupHovered.peek()) {
					set_visible(false)
				}
				autoHideTimer = undefined
			})
		}

		let pendingAction: (() => void) | undefined

		const dismiss = () => {
			clearTimer()
			pendingAction = () => {
				manager.removeNotification(notification.id)
				notification.dismiss()
			}
			set_visible(false)
		}

		const onActionClick = (actionId: string) => {
			clearTimer()
			pendingAction = () => {
				manager.removeNotification(notification.id)
				notification.invoke(actionId)
			}
			set_visible(false)
		}

		const dismissSub = dismissingAll.subscribe(() => {
			const idx = getIndex()
			if (dismissingAll.peek() && idx !== undefined) {
				timeout(staggerDelay(idx), () => set_visible(false))
			}
		})

		const hoverSub = popupHovered.subscribe(() => {
			if (!persistent) {
				if (popupHovered.peek()) {
					clearTimer()
				} else if (visible.peek()) {
					scheduleAutoHide(true)
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
					if (!mounted && (!manager.dontDisturb || persistent)) {
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
							if (!persistent) manager.popupHovered = true
							set_showActions(true)
						}}
						onLeave={() => {
							if (!persistent) manager.popupHovered = false
							set_showActions(false)
						}}
					/>
					<box class="header">
						<image class="app-icon" iconName={appIcon} useFallback />
						<label class="app-name" halign={START} maxWidthChars={24} ellipsize={Pango.EllipsizeMode.END} useMarkup label={appName} />
						<label class="time" halign={END} hexpand label={env.uptime(() => formatTime(notification.time))} />
						<revealer revealChild={showActions} transitionDuration={options.transition.duration} transitionType={SWING_RIGHT}>
							<button class="close-button" onClicked={dismiss}>
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
				<For each={notifications}>{(n, i) => <Entry entry={n} persistent={persistent} index={i} />}</For>
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
		return (
			<window visible resizable={false} heightRequest={1} widthRequest={350} name="notifications" class="notifications" application={app} exclusivity={EXCLUSIVE} anchor={TOP | RIGHT}>
				<Stack persistent={false} />
			</window>
		)
	}
}
