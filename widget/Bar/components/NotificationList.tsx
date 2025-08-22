import { Accessor, createState } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import AstalNotifd from "gi://AstalNotifd"

import GLib from "gi://GLib"

import icons from "$lib/icons"
import { lookupIcon } from "$lib/utils"
import { notifd } from "$lib/services"

import options from "options"
import { timeout } from "ags/time"

const { TOP, RIGHT } = Astal.WindowAnchor
const { START, CENTER, END } = Gtk.Align
const { SLIDE_DOWN } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation

function isIcon(icon: string) {
	return !!lookupIcon(icon)
}

function fileExists(path: string) { return GLib.file_test(path, GLib.FileTest.EXISTS) }

function formatTime(time: number, format: string = "%H:%M"): string {
	return GLib.DateTime.new_from_unix_local(time).format(format) ?? ""
}

function urgency(n: AstalNotifd.Notification) {
	const { LOW, NORMAL, CRITICAL } = AstalNotifd.Urgency
	switch (n.urgency) {
		case LOW: return "low"
		case CRITICAL: return "critical"
		case NORMAL:
		default: return "normal"
	}
}

type Props = {
	$?(self: Gtk.EventControllerMotion): void
	onLeave?(self: Gtk.EventControllerMotion): void
	notification: AstalNotifd.Notification
	css?: string | Accessor<string>
}

export function Notification(props: Props) {
	const { notification: n, onLeave, $, css } = props
	const [revealActions, set_revealActions] = createState(false)

	return (
		<Gtk.EventControllerMotion
			$={$}
			onEnter={() => set_revealActions(true)}
			onLeave={(self) => {
				set_revealActions(false)
				onLeave && onLeave(self)
			}}
		>
			<box
				class={`notification ${urgency(n)}`}
				css={css ?? ""}
				orientation={VERTICAL}
			>
				<box class="header">
					{<image
						class="app-icon"
						iconName={n.appIcon || n.desktopEntry || icons.fallback.notification}
						useFallback
					/>}
					<label
						class="app-name"
						halign={START}
						use_markup
						maxWidthChars={24}
						label={(n.appName || n.desktopEntry || "Notification").toUpperCase()}
					/>
					<label
						class="time"
						halign={END}
						hexpand
						label={formatTime(n.time)}
					/>
					<button class="close-button" onClicked={() => n.dismiss()}>
						<image iconName="window-close-symbolic" useFallback />
					</button>
				</box>
				<box class="content">
					{n.image && fileExists(n.image) &&
						<box
							class="icon image"
							css={`background-image: url('${n.image}');
                background-size: cover;
                background-repeat: no-repeat;
                background-position: center;
                min-width: 78px;
                min-height: 78px;`}
							valign={START}
						/>
					}
					{n.image && isIcon(n.image) &&
						<box
							vexpand={false} hexpand={false}
							valign={START}
							class="icon">
							<image iconName={n.image} vexpand hexpand valign={CENTER} halign={CENTER} useFallback />
						</box>
					}
					<box orientation={VERTICAL}>
						<label
							class="summary"
							halign={START}
							maxWidthChars={20}
							label={n.summary}
						/>
						{n.body && <label
							class="body"
							halign={START}
							wrap
							useMarkup
							maxWidthChars={20}
							label={n.body}
						/>}
					</box>
				</box>
				{n.get_actions().length > 0 && <revealer
					revealChild={revealActions}
					transitionType={SLIDE_DOWN}
				>
					<box class="actions horizontal">
						{n.get_actions().map(({ label, id }) => (
							<button
								hexpand
								onClicked={() => n.invoke(id)}>
								<label label={label} halign={CENTER} hexpand />
							</button>
						))}
					</box>
				</revealer>}
			</box>
		</Gtk.EventControllerMotion>
	)
}

function AnimatedNotification(props: Props) {
	return (<revealer transitionDuration={options.transition.get()} transitionType={SLIDE_DOWN}
		$={self => timeout(options.transition.get(), () => {
			if (!self.in_destruction()) {
				self.revealChild = true
			}
		})}
	>
		<Notification {...props} />
	</revealer>
	)
}

export function NotificationList({ persistent: persistent }: { persistent?: boolean }) {
	const map = new Map<number, ReturnType<typeof AnimatedNotification>>()

	function remove(id: number) {
		const notif = map.get(id) as Gtk.Revealer
		if (notif) {
			notif.reveal_child = false
			map.delete(id)
			timeout(options.transition.get(), () => {
				notif.run_dispose()
			})
		}
	}

	return (
		<box
			orientation={VERTICAL}
			$={self => {
				notifd.connect("resolved", (_, id) => remove(id))
				notifd.connect("notified", (_, id) => {
					if (id !== undefined) {
						map.has(id) && remove(id)
						const notif = notifd.get_notification(id)

						if (options.notifications.blacklist.get().includes(notif.appName || notif.desktopEntry) || !persistent && notifd.dontDisturb) {
							return
						}

						const animated = <AnimatedNotification css={options.notifications.width.as(w => `min-width: ${w}px;`)} notification={notif} />
						map.set(id, animated)
						self.children = [animated, ...self.children]
						if (!persistent) {
							timeout(options.notifications.dismiss.get(), () => {
								remove(id)
							})
						}
					}
				})
			}}
		>
			{persistent == true &&
				notifd.notifications
					.filter(n => !options.notifications.blacklist.get().includes(n.appName || n.desktopEntry)).map(n => {
						const animated = <AnimatedNotification notification={n} />
						map.set(n.id, animated)
						return animated
					})
			}
		</box >
	)
}

export default (gdkmonitor: Gdk.Monitor) =>
	<window
		class="notifications"
		gdkmonitor={gdkmonitor}
		exclusivity={Astal.Exclusivity.EXCLUSIVE}
		anchor={TOP | RIGHT}
	>
		<box orientation={VERTICAL}>
			<NotificationList />
		</box>
	</window>

