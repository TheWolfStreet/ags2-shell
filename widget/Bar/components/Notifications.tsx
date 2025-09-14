import { Accessor, createState, For, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import PanelButton from "./PanelButton"

import { notifd } from "$lib/services"
import icons from "$lib/icons"
import { env } from "$lib/env"
import { fileExists, textureFromFile, toggleWindow } from "$lib/utils"

import options from "options"

const { COVER } = Gtk.ContentFit
const { START, CENTER, END } = Gtk.Align
const { SWING_RIGHT, SWING_DOWN, SLIDE_DOWN } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation

const MAX_NOTIFICATIONS = 50
const STAGGER_DELAY_MAX = 500

function format(time: number): string {
	const now = GLib.DateTime.new_now_local()
	const then = GLib.DateTime.new_from_unix_local(time)
	if (!then) return ""
	const diff = now.to_unix() - then.to_unix()
	if (diff < 60) return "now"
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
	return `${Math.floor(diff / 86400)}d ago`
}

function urgency(n: AstalNotifd.Notification): string {
	const { LOW, CRITICAL } = AstalNotifd.Urgency
	switch (n.urgency) {
		case LOW: return "low"
		case CRITICAL: return "critical"
		default: return "normal"
	}
}

export namespace Notifications {
	let hoverCount = 0

	const [hovered, setHovered] = createState(false)
	const [dismiss, set_dismiss] = createState(false)
	const [_current, set_current] = createState<Array<AstalNotifd.Notification>>([])

	export const current = _current

	const notifyHandler = notifd.connect("notified", (_, id, replaced) => {
		const notification = notifd.get_notification(id)
		const blacklist = options.notifications.blacklist.get() || []

		const appName = notification.get_app_name() || notification.get_desktop_entry()
		if (blacklist.includes(appName)) return

		if (replaced && _current.get().some((n) => n.id === id)) {
			set_current((ns) => ns.map((n) => (n.id === id ? notification : n)))
		} else {
			set_current((ns) => [notification, ...ns].slice(0, MAX_NOTIFICATIONS))
		}
	})

	onCleanup(() => {
		notifd.disconnect(notifyHandler)
	})

	export function dismissAll() {
		set_dismiss(true)
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.transition.duration.get(), () => {
			set_dismiss(false)
			set_current([])
			return GLib.SOURCE_REMOVE
		})
	}

	interface EntryProps {
		entry: AstalNotifd.Notification
		widthRequest?: Accessor<number> | number
		persistent?: boolean
	}

	function Entry({ entry: notification, widthRequest, persistent }: EntryProps) {
		const [reveal, setReveal] = createState(false)
		const [revealActions, setRevealActions] = createState(false)

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
			set_current((notifications) => notifications.filter((notif) => notif !== notification))
			notification.dismiss()
		}

		const startAutoHide = () => {
			if (persistent) return
			clearTimer()
			dismissTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.notifications.dismiss.get(), () => {
				if (!hovered.get()) setReveal(false)
				dismissTimer = undefined
				return GLib.SOURCE_REMOVE
			})
		}

		const handleDismiss = () => {
			if (!dismiss.get()) return
			setReveal(false)
			GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.notifications.dismiss.get(), () => {
				notification.dismiss()
				return GLib.SOURCE_REMOVE
			})
		}

		const onEnter = () => {
			if (closed) return
			setRevealActions(true)
			if (!persistent) {
				hoverCount++
				setHovered(true)
				clearTimer()
			}
		}

		const onLeave = () => {
			if (closed) return
			setRevealActions(false)
			if (!persistent) {
				hoverCount--
				if (hoverCount <= 0) {
					hoverCount = 0
					setHovered(false)
				}
			}
		}

		const onReveal = (self: Gtk.Revealer) => {
			if (!self.get_reveal_child() && closed) {
				remove()
			} else {
				startAutoHide()
			}
		}

		const onClose = () => {
			setReveal(false)
			closed = true
		}

		const onActionClick = (actionId: string) => {
			setReveal(false)
			GLib.timeout_add(GLib.PRIORITY_DEFAULT, options.transition.duration.get(), () => {
				set_current((notifications) => notifications.filter((notif) => notif !== notification))
				notification.invoke(actionId)
				return GLib.SOURCE_REMOVE
			})
		}

		const dismissUnsub = dismiss.subscribe(handleDismiss)
		const hoveredUnsub = hovered.subscribe(() => {
			if (!hovered.get() && !persistent && !closed) {
				const delay = Math.random() * STAGGER_DELAY_MAX
				GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
					if (!hovered.get()) startAutoHide()
					return GLib.SOURCE_REMOVE
				})
			}
		})

		onCleanup(() => {
			dismissUnsub()
			hoveredUnsub()
			clearTimer()
			if (!persistent && !closed) {
				hoverCount = Math.max(0, hoverCount - 1)
				if (hoverCount === 0) {
					setHovered(false)
				}
			}
		})

		const appIcon = notification.appIcon || notification.desktopEntry || icons.fallback.notification
		const appName = (notification.appName || notification.desktopEntry || "Notification").toUpperCase()
		const hasImage = notification.get_image() && fileExists(notification.get_image())
		const validActions = notification.get_actions().filter(action => action.label?.trim())

		return (
			<revealer
				revealChild={reveal}
				transitionDuration={options.transition.duration}
				transitionType={SLIDE_DOWN}
				onNotifyChildRevealed={onReveal}
				onMap={() => {
					if (!wasShown && (!notifd.get_dont_disturb() || persistent)) {
						setReveal(true)
						wasShown = true
					}
				}}
			>
				<box class={`notification ${urgency(notification)}`} orientation={VERTICAL} widthRequest={widthRequest}>
					<Gtk.EventControllerMotion onEnter={onEnter} onLeave={onLeave} />
					<box class="header">
						<image class="app-icon" iconName={appIcon} useFallback />
						<label
							class="app-name"
							halign={START}
							maxWidthChars={24}
							ellipsize={Pango.EllipsizeMode.END}
							useMarkup
							label={appName}
						/>
						<label
							class="time"
							halign={END}
							hexpand
							label={env.uptime(() => format(notification.time))}
						/>
						<revealer
							revealChild={revealActions}
							transitionDuration={options.transition.duration}
							transitionType={SWING_RIGHT}
						>
							<button class="close-button" onClicked={onClose}>
								<image iconName={icons.ui.close} halign={CENTER} valign={CENTER} useFallback />
							</button>
						</revealer>
					</box>

					<box class="content">
						{hasImage && (
							<Gtk.Picture
								class="icon"
								contentFit={COVER}
								canShrink={false}
								paintable={textureFromFile(notification.get_image(), 75, 75) as Gdk.Paintable}
							/>
						)}
						<box orientation={VERTICAL}>
							<label
								class="summary"
								wrap
								wrapMode={Gtk.WrapMode.WORD}
								maxWidthChars={28}
								halign={START}
								label={notification.summary}
							/>
							{notification.body && (
								<label
									class="body"
									wrap
									wrapMode={Gtk.WrapMode.WORD}
									maxWidthChars={28}
									halign={START}
									useMarkup
									label={notification.body}
								/>
							)}
						</box>
					</box>

					{validActions.length > 0 && (
						<revealer
							revealChild={revealActions}
							transitionType={SWING_DOWN}
							transitionDuration={options.transition.duration}
						>
							<box class="actions horizontal">
								{validActions.map(({ label, id }) => (
									<button hexpand label={label} onClicked={() => onActionClick(id)} />
								))}
							</box>
						</revealer>
					)}

				</box>
			</revealer >
		)
	}

	export function Stack({ class: className, persistent = false }: {
		class?: string,
		hexpand?: boolean | Accessor<boolean>,
		persistent?: boolean
	}) {
		return (
			<box class={className} orientation={VERTICAL} valign={START}>
				<For each={current}>
					{(n: AstalNotifd.Notification) => <Entry entry={n} persistent={persistent} />}
				</For>
			</box>
		)
	}

	export function Button() {
		return (
			<PanelButton
				class="messages"
				visible={current.as(v => v.length > 0)}
				tooltipText={current.as(v => `${v.length} pending notification${v.length === 1 ? '' : 's'}`)}
				onClicked={() => toggleWindow("datemenu")}
			>
				<image iconName={icons.notifications.message} useFallback />
			</PanelButton>
		)
	}

	export function Window() {
		const { EXCLUSIVE } = Astal.Exclusivity
		const { TOP, RIGHT } = Astal.WindowAnchor

		return (
			<window
				visible
				resizable={false}
				heightRequest={1}
				widthRequest={1}
				name="notifications"
				class="notifications"
				application={app}
				exclusivity={EXCLUSIVE}
				anchor={TOP | RIGHT}
			>
				<Stack persistent={false} />
			</window>
		)
	}
}
