import Mpris from "gi://AstalMpris"
import { Variable, bind, timeout } from "astal"
import { Gtk, Widget, Gdk, Astal, } from "astal/gtk3"
import { Menu, MenuItem } from "../../GtkWidgets"

import PanelButton from "./PanelButton"

import { toggleWindow, initHook, duration } from "../../../lib/utils"
import { cpick, hypr, media, notifd, scr, tray } from "../../../lib/services"
import icons from "../../../lib/icons"
import options from "../../../options"

const { exclusive } = options.bar.taskbar
const { preferred } = options.bar.media
const { position } = options.bar

const { PLAYING } = Mpris.PlaybackStatus
const { START, CENTER, END } = Gtk.Align
const { SLIDE_LEFT } = Gtk.RevealerTransitionType
const { BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_MIDDLE } = Gdk

export function Media() {
	const hovered = Variable(false)
	return Variable.derive([bind(media, "players"), preferred], (ps, pref) => {
		const player = ps.find(p => p.get_bus_name().includes(pref)) || ps[0]
		if (!player) return <box visible={false} />

		return (
			<PanelButton
				className="media"
				onHover={() => hovered.set(true)}
				onHoverLost={() => hovered.set(false)}
				onClick={() => player.get_playback_status() === PLAYING ? player.pause() : player.play()}
			>
				<box className="horizontal" halign={CENTER} valign={CENTER}>
					<icon valign={CENTER} icon={player.get_entry()} useFallback />
					<revealer
						transitionType={SLIDE_LEFT}
						revealChild={hovered()}
						setup={self => {
							let current = ""
							self.hook(bind(player, "title"), () => {
								const title = player.get_title()
								if (current !== title) {
									current = title
									self.set_reveal_child(true)
									timeout(2500, () => !self.in_destruction() && (self.set_reveal_child(false)))
								}
							})
						}}
					>
						<label valign={CENTER} truncate={true} maxWidthChars={45} label={
							Variable.derive([bind(player, "title"), bind(player, "artist")], (title, artist) => {
								return `${title || "Untitled"}${artist ? ` - ${artist}` : ""}`
							})()
						} />
					</revealer>
				</box>
			</PanelButton>
		)
	})()
}

export function ColorPicker() {
	const css = (color: string) => `
		* {
				background-color: ${color};
				color: transparent;
		}
		*:hover {
				color: white;
				text-shadow: 2px 2px 3px rgba(0,0,0,.8);
		}`


	const menu = <Menu className="colorpicker">
		{bind(cpick, "colors").as(c => c.map((color) =>
			<MenuItem
				css={css(color)}
				onActivate={() => cpick.wlCopy(color)}>
				<label hexpand halign={START} label={color} />
			</MenuItem>
		))}
	</Menu> as Gtk.Menu

	return (
		<PanelButton className="color-picker"
			tooltipText={bind(cpick, "colors").as(v => `${v.length} color${v.length === 1 ? "" : "s"}`)}
			onClick={(self: Widget.Button, event: Astal.ClickEvent) => {
				switch (event.button) {
					case BUTTON_PRIMARY:
						cpick.pick()
						break
					case BUTTON_SECONDARY:
						(cpick.colors.length > 0) && menu.popup_at_widget(self, Gdk.Gravity.SOUTH, Gdk.Gravity.NORTH, null)
						break
					default: break
				}
			}}
			setup={self => {
				self.hook(menu, "popped-up", () => self.toggleClassName("active"))

				self.hook(menu, "notify::visible", () => self.toggleClassName("active", menu.visible))
			}}
		>
			<icon icon={icons.ui.colorpicker} useFallback />
		</PanelButton >
	)
}

export function PendingNotifications() {
	const notifCount = bind(notifd, "notifications").as(n =>
		n.filter(notif => {
			return !options.notifications.blacklist.get().includes(notif.appName || notif.desktopEntry)
		}).length)

	return (
		<PanelButton
			className="messages"
			visible={notifCount.as(v => v > 0)}
			tooltipText={notifCount.as(v => `${v} pending notification${v === 1 ? '' : 's'} `)}
			onClick={() => toggleWindow("datemenu")}>
			<icon icon={icons.notifications.message} useFallback />
		</ PanelButton>
	)
}

export const ScreenRecord = () =>
	<PanelButton className="recorder" visible={bind(scr, "recording")} onClick={() => scr.stop()}>
		<box className="horizontal">
			<icon icon={icons.recorder.recording} />
			<label label={bind(scr, "timer").as(duration)} />
		</box>
	</PanelButton>

export const PowerButton = () =>
	<PanelButton className="powerbutton"
		setup={self => self.toggleClassName("box")}
		onClick={() => toggleWindow("powermenu")}
	>
		<icon icon={icons.powermenu.shutdown} useFallback />
	</PanelButton>

function AppItem({ address }: { address: string }) {
	const focusedWs = bind(hypr, "focusedWorkspace")
	const focusedCl = bind(hypr, "focusedClient")

	const client = hypr.get_client(address)
	const visible = Variable.derive([focusedWs, exclusive], (ws, e) => {
		return e ? ws?.id === client?.workspace.id : true
	})
	const active = focusedCl.as(v => v && v.address === address)

	if (!client || client.class === "") {
		return <box visible={false} name={address} />
	}

	return (
		<overlay
			name={address}
			passThrough
			overlay={
				<box
					className="indicator"
					halign={CENTER}
					valign={position(p => (p === "top" ? START : END))}
					visible={focusedWs.as(v => v?.clients?.length > 0)}
					setup={self => {
						initHook(self, active, () => {
							self.toggleClassName("active", active.get())
						})
					}}
				/>
			}
		>
			<PanelButton
				visible={visible()}

				tooltipText={
					bind(client, "title")
				}
				onClick={(_: Widget.Button, event: Astal.ClickEvent) => {
					const client = hypr.get_client(address)

					if (client) {
						switch (event.button) {
							case BUTTON_PRIMARY:
								client.focus()
								break
							case BUTTON_SECONDARY:
								client.focus()
								hypr.message(`dispatch fullscreen`)
								break
							case BUTTON_MIDDLE:
								client.kill()
								break
							default:
								break
						}
					}
				}}
			>
				<icon
					icon={bind(client, "class").as(v => v.toString())}
					useFallback
				/>
			</PanelButton>
		</overlay >
	)
}

function sortItems<T extends { name: string }>(arr: (T | null)[]) {
	const valid_items = arr.filter(item => item !== null && item !== undefined) as T[]

	return valid_items.sort((a, b) => {
		const aclient = hypr.get_client(a.name)
		const bclient = hypr.get_client(b.name)

		if (!aclient || !bclient) {
			return 0
		}

		return aclient.workspace.id - bclient.workspace.id
	})
}

export const Taskbar = () =>
	<box
		className="taskbar"
		setup={self => {
			self.hook(hypr, "client-removed", (_, address) => {
				if (typeof address === "string") {
					self.get_children().filter(
						c => c.name == address
					).forEach(c => c.destroy())
				}
			})

			self.hook(hypr, "client-added", (_, client) => {
				if (typeof client.address === "string") {
					self.children = sortItems([...self.children, <AppItem address={client.address} />])
				}
			})

			self.hook(hypr, "event", (_, event) => {
				if (event === "movewindow") {
					self.children = sortItems(self.children)
				}
			})

			return self
		}}
	>
		{sortItems(
			hypr.workspaces
				.map(w => w.clients.map(c => (c.address)))
				.flat()
				.map(c => {
					return <AppItem address={c} />
				})
		)}
	</box>

export const SysTray = () =>
	<box>
		{bind(tray, "items").as(items => items.filter(item => !options.bar.systray.ignore.get().includes(item.title) && item.gicon).map(item => (
			<menubutton
				className="panel-button"
				tooltipMarkup={bind(item, "tooltipMarkup")}
				usePopover={false}
				// @ts-ignore: It exists, but for some reason is not defined
				actionGroup={bind(item, "actionGroup").as(ag => ["dbusmenu", ag])}
				menuModel={bind(item, "menuModel")}>
				<icon gicon={bind(item, "gicon")} />
			</menubutton>
		)))}
	</box>
