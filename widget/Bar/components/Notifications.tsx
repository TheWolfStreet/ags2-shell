import { Accessor, createBinding, createComputed, createState, For } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { Time, timeout } from "ags/time"

import GdkPixbuf from "gi://GdkPixbuf"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

import PanelButton from "./PanelButton"

import icons from "$lib/icons"
import { env } from "$lib/env"
import { fileExists, toggleWindow } from "$lib/utils"
import { notifd } from "$lib/services"

import options from "options"

const { COVER } = Gtk.ContentFit
const { START, CENTER, END } = Gtk.Align
const { SWING_RIGHT, SWING_DOWN, SLIDE_DOWN } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation

export namespace Notifications {
	let hovered = false

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

	function Entry({ entry: n, persistent }: { entry: AstalNotifd.Notification, persistent: boolean }) {
		const [reveal, setReveal] = createState(false)
		const [revealActions, setRevealActions] = createState(false)
		let dismissTimer: Time | undefined

		timeout(1, () => setReveal(true))

		const autoDismiss = () => {
			if (persistent) return
			dismissTimer?.cancel()
			dismissTimer = timeout(options.notifications.dismiss.get(), () => {
				if (!hovered) {
					setReveal(false)
					timeout(options.transition.duration.get(), () => n.dismiss())
				}
			})
		}

		if (!persistent) autoDismiss()

		return (
			<revealer revealChild={reveal} transitionDuration={options.transition.duration} transitionType={SLIDE_DOWN}>
				<box class={`notification ${urgency(n)}`} orientation={VERTICAL} hexpand>
					<Gtk.EventControllerMotion
						onEnter={() => { setRevealActions(true); hovered = true; dismissTimer?.cancel() }}
						onLeave={() => { setRevealActions(false); hovered = false; autoDismiss() }}
					/>

					<box class="header">
						<image class="app-icon" iconName={n.appIcon || n.desktopEntry || icons.fallback.notification} useFallback />
						<label class="app-name" halign={START} use_markup maxWidthChars={24} ellipsize={Pango.EllipsizeMode.END}
							label={(n.appName || n.desktopEntry || "Notification").toUpperCase()} />
						<label class="time" halign={END} hexpand label={env.uptime(() => format(n.time))} />

						<revealer revealChild={revealActions} transitionDuration={options.transition.duration} transitionType={SWING_RIGHT}>
							<button class="close-button" onClicked={() => { setReveal(false); timeout(options.transition.duration.get(), () => n.dismiss()) }}>
								<image iconName={icons.ui.close} halign={CENTER} valign={CENTER} useFallback />
							</button>
						</revealer>
					</box>

					<box class="content">
						{n.get_image() && fileExists(n.get_image()) &&
							<Gtk.Picture
								class="icon" halign={CENTER} contentFit={COVER} canShrink={false}
								paintable={Gdk.Texture.new_for_pixbuf(
									GdkPixbuf.Pixbuf.new_from_file(n.get_image()).scale_simple(75, 75, GdkPixbuf.InterpType.BILINEAR)!
								)}
							/>
						}
						<box orientation={VERTICAL}>
							<label class="summary" halign={START} maxWidthChars={20} wrap label={n.summary} />
							{n.body && <label class="body" halign={START} wrap useMarkup maxWidthChars={20} label={n.body} />}
						</box>
					</box>

					{n.get_actions().filter(a => a.label?.trim()).length > 0 &&
						<revealer revealChild={revealActions} transitionType={SWING_DOWN} transitionDuration={options.transition.duration}>
							<box class="actions horizontal">
								{n.get_actions().filter(a => a.label?.trim()).map(({ label, id }) =>
									<button hexpand onClicked={() => n.invoke(id)}>
										<label label={label} halign={CENTER} hexpand />
									</button>
								)}
							</box>
						</revealer>
					}
				</box>
			</revealer>
		)
	}

	export const current = createComputed(
		[createBinding(notifd, "notifications"), options.notifications.blacklist],
		(notifs, blacklist) => notifs.filter(n => !blacklist.includes(n.get_app_name() || n.get_desktop_entry()))
	)

	export function Stack({ hexpand, class: class_name, persistent = false }: { hexpand?: boolean | Accessor<boolean>, class?: string, persistent?: boolean }) {
		return (
			<box orientation={VERTICAL} class={class_name} hexpand={hexpand}>
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
				visible={Notifications.current.as(v => v.length > 0)}
				tooltipText={Notifications.current.as(v => `${v.length} pending notification${v.length === 1 ? '' : 's'}`)}
				onClicked={() => toggleWindow("datemenu")}
			>
				<image iconName={icons.notifications.message} useFallback />
			</PanelButton>
		)
	}

	export function Window() {
		const { OVERLAY } = Astal.Layer
		const { EXCLUSIVE } = Astal.Exclusivity
		const { TOP, RIGHT } = Astal.WindowAnchor

		return (
			<window
				name="notifications"
				class="notifications"
				visible
				application={app}
				layer={OVERLAY}
				exclusivity={EXCLUSIVE}
				anchor={TOP | RIGHT}
			>
				<box widthRequest={options.notifications.width}>
					<Stack persistent={false} />
				</box>
			</window>
		)
	}
}
