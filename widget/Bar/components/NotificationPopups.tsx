import Notifd from "gi://AstalNotifd"
import { Binding, GLib, timeout, Variable } from "astal"
import { Gtk, Gdk, Astal } from "astal/gtk3"
import { type EventBox } from "astal/gtk3/widget"

import icons from "../../../lib/icons"
import { notifd } from "../../../lib/services"
import options from "../../../options"

const { TOP, RIGHT } = Astal.WindowAnchor
const { START, CENTER, END } = Gtk.Align
const { SLIDE_DOWN } = Gtk.RevealerTransitionType

function isIcon(icon: string) {
	return !!Astal.Icon.lookup_icon(icon)
}

function fileExists(path: string) { return GLib.file_test(path, GLib.FileTest.EXISTS) }

function formatTime(time: number, format: string = "%H:%M"): string {
	return GLib.DateTime.new_from_unix_local(time).format(format) ?? ""
}

function urgency(n: Notifd.Notification) {
	const { LOW, NORMAL, CRITICAL } = Notifd.Urgency
	switch (n.urgency) {
		case LOW: return "low"
		case CRITICAL: return "critical"
		case NORMAL:
		default: return "normal"
	}
}

type Props = {
	setup?(self: EventBox): void
	onHoverLost?(self: EventBox): void
	notification: Notifd.Notification
	css?: string | Binding<string>
}

export function Notification(props: Props) {
	const { notification: n, onHoverLost, setup, css } = props
	const revealActions = Variable(false)

	return (
		<eventbox
			setup={setup}
			onHover={() => revealActions.set(true)}
			onHoverLost={(self) => {
				revealActions.set(false)
				onHoverLost && onHoverLost(self)
			}}
		>
			<box
				className={`notification ${urgency(n)}`}
				css={css ?? ""}
				vertical
			>
				<box className="header">
					{<icon
						className="app-icon"
						icon={n.appIcon || n.desktopEntry || icons.fallback.notification}
						useFallback
					/>}
					<label
						className="app-name"
						halign={START}
						truncate
						use_markup
						maxWidthChars={24}
						label={(n.appName || n.desktopEntry || "Notification").toUpperCase()}
					/>
					<label
						className="time"
						halign={END}
						hexpand
						label={formatTime(n.time)}
					/>
					<button className="close-button" onClicked={() => n.dismiss()}>
						<icon icon="window-close-symbolic" useFallback />
					</button>
				</box>
				<box className="content">
					{n.image && fileExists(n.image) &&
						<box
							className="icon image"
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
							className="icon">
							<icon icon={n.image} vexpand hexpand valign={CENTER} halign={CENTER} useFallback />
						</box>
					}
					<box vertical>
						<label
							className="summary"
							halign={START}
							truncate
							maxWidthChars={20}
							label={n.summary}
						/>
						{n.body && <label
							className="body"
							halign={START}
							wrap
							useMarkup
							maxWidthChars={20}
							label={n.body}
						/>}
					</box>
				</box>
				{n.get_actions().length > 0 && <revealer
					revealChild={revealActions()}
					transitionType={SLIDE_DOWN}
				>
					<box className="actions horizontal">
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
		</eventbox>
	)
}

function AnimatedNotification(props: Props) {
	return (<revealer transitionDuration={options.transition.get()} transitionType={SLIDE_DOWN}
		setup={self => timeout(options.transition.get(), () => {
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
				notif.destroy()
			})
		}
	}

	return (
		<box
			vertical
			setup={self => {
				self.hook(notifd, "resolved", (_, id) => remove(id))
				self.hook(notifd, "notified", (_, id) => {
					if (id !== undefined) {
						map.has(id) && remove(id)
						const notif = notifd.get_notification(id)

						if (options.notifications.blacklist.get().includes(notif.appName || notif.desktopEntry) || !persistent && notifd.dontDisturb) {
							return
						}

						const animated = <AnimatedNotification css={options.notifications.width(w => `min-width: ${w}px;`)} notification={notif} />
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
		className="notifications"
		gdkmonitor={gdkmonitor}
		exclusivity={Astal.Exclusivity.EXCLUSIVE}
		anchor={TOP | RIGHT}
	>
		<box vertical>
			<NotificationList />
		</box>
	</window>
