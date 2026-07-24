// Shows notification popups and history with timed animations.

import { Accessor, createState, createBinding, createComputed, For, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import AstalNotifd from "gi://AstalNotifd"
import Pango from "gi://Pango"

import { PanelButton } from "../PanelButton"

import env from "$lib/env"
import icons, { getIcon } from "$lib/icons"
import { timeAgo } from "$lib/format"
import { toggleWindow } from "$lib/windows"
import { isDataImageUri, textureFromUriSquareContainAsync } from "$lib/textures"
import { notificationManager } from "$service/notifications"
import { createEntryLifecycle, staggerDelay, type EntryIndex, type VisibilityController } from "./lifecycle"

import options from "options"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { WORD } = Gtk.WrapMode
const { SLIDE_DOWN, SWING_RIGHT, SWING_DOWN } = Gtk.RevealerTransitionType
const { EllipsizeMode } = Pango
const { NORMAL } = Astal.Exclusivity
const { TOP, RIGHT, LEFT, BOTTOM } = Astal.WindowAnchor

export namespace Notifications {
	type NotificationProps = {
		entry: AstalNotifd.Notification
		widthRequest?: Accessor<number> | number
		persistent?: boolean
		index?: EntryIndex
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
	const popupHovered = createBinding(notificationManager, "popupHovered")

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
			|| isDataImageUri(value)
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
		const previewPaintable = imagePath ? textureFromUriSquareContainAsync(imagePath, 75) : null

		return (
			<box class="content">
				{previewPaintable && (
					<box class="image-preview" widthRequest={75} heightRequest={75}>
						<Gtk.Picture
							class="preview"
							widthRequest={75}
							heightRequest={75}
							halign={CENTER}
							valign={CENTER}
							paintable={previewPaintable as unknown as Accessor<Gdk.Paintable>}
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

	function Notification({ entry: notification, widthRequest, persistent, index }: NotificationProps) {
		const visibility = createVisibilityController(false)
		const [showActions, setShowActions] = createState(false)

		const state = createEntryLifecycle({
			notification,
			persistent: persistent ?? false,
			index,
			visibility,
			popupHovered,
			dismissingAll,
		})

		const dismissSub = dismissingAll.subscribe(state.onDismissAllChanged)
		const hoverSub = popupHovered.subscribe(state.onPopupHoveredChanged)

		onCleanup(() => {
			dismissSub()
			hoverSub()
			state.cleanup()
		})

		const imageValue = notification.get_image()
		const imagePath = isPreviewImage(imageValue) ? imageValue : null
		const appIcon = getIcon(
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
				transitionType={SLIDE_DOWN}
				onMap={state.onMap}
				onNotifyChildRevealed={(self) => {
					state.onChildRevealed(self.get_reveal_child())
				}}
			>
				<box class={`notification ${urgency(notification)}`} orientation={VERTICAL} widthRequest={widthRequest}>
					<Gtk.EventControllerMotion
						onEnter={() => {
							if (!persistent) notificationManager.popupHovered = true
							setShowActions(true)
						}}
						onLeave={() => {
							if (!persistent) notificationManager.popupHovered = false
							setShowActions(false)
						}}
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

	export function dismissAll() {
		notificationManager.dismissAll(options.transition.duration.peek(), maxStaggerDelay())
	}

	export function Stack({ persistent = false, class: className }: { persistent?: boolean, class?: string }) {
		return (
			<box class={className || "notifications-stack"} orientation={VERTICAL} valign={START}>
				<For each={notifications}>{(n, i) => <Notification entry={n} persistent={persistent} index={i} />}</For>
			</box>
		)
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
				widthRequest={350}
				name="notifications"
				class="notifications"
				application={app}
				exclusivity={NORMAL}
				anchor={anchor}
			>
				<Stack persistent={false} />
			</window>
		)
	}
}
