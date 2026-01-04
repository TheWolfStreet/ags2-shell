import { Gdk, Gtk } from "ags/gtk4"
import { timeout, Timer } from "ags/time"
import { createBinding, createComputed, createState, For, With, onCleanup } from "ags"

import AstalTray from "gi://AstalTray"
import AstalHyprland from "gi://AstalHyprland"
import AstalMpris from "gi://AstalMpris"
import Pango from "gi://Pango"
import { PanelButton } from "../PanelButton"

import { cpick, hypr, media, scr, tray } from "$lib/services"
import icons from "$lib/icons"
import { duration, getClientTitle } from "$lib/utils"

import options from "options"

const { exclusive } = options.bar.taskbar
const { preferred } = options.bar.media

const { PLAYING } = AstalMpris.PlaybackStatus
const { SLIDE_LEFT } = Gtk.RevealerTransitionType

const { CENTER, START } = Gtk.Align
const { VERTICAL, HORIZONTAL } = Gtk.Orientation

export function Tray() {
	const items = createComputed([createBinding(tray, "items"), options.bar.systray.ignore], (items, ignore) => {
		const ignoreSet = new Set(ignore)
		return items.filter(i => !ignoreSet.has(i.get_title()) && i.get_gicon())
	})

	function init(btn: Gtk.MenuButton, item: AstalTray.TrayItem) {
		btn.menuModel = item.menuModel
		btn.insert_action_group("dbusmenu", item.actionGroup)
		item.connect("notify::action-group", () => {
			btn.insert_action_group("dbusmenu", item.actionGroup)
		})
	}

	return (
		<box>
			<For each={items}>
				{(item) => (
					<menubutton valign={CENTER} halign={CENTER}
						$={self => {
							init(self, item)
							self.get_popover()?.set_has_arrow(false)
						}
						}>
						<image gicon={createBinding(item, "gicon")} useFallback />
					</menubutton>
				)}
			</For>
		</box>
	)
}

export function Tasks() {
	function Entry({ client }: { client: AstalHyprland.Client }) {
		if (!client || client.class === "") {
			return <box visible={false} />
		}

		const visible = createComputed([createBinding(client, "workspace"), createBinding(hypr, "focusedWorkspace"), exclusive], (w, focused, exclusive) => {
			if (exclusive) {
				return w?.id == focused?.id
			}
			return true
		})

		const focused = createBinding(hypr, "focusedClient").as(v => {
			return v?.address === client.address;
		})

		return (
			<overlay tooltipText={getClientTitle(client)} visible={visible}>
				<Gtk.GestureClick
					button={0}
					onPressed={self => {
						const mBtn = self.get_current_button()
						switch (mBtn) {
							case Gdk.BUTTON_PRIMARY:
								client.focus()
								break
							case Gdk.BUTTON_SECONDARY:
								client.focus()
								hypr.message("dispatch fullscreen")
								break
							case Gdk.BUTTON_MIDDLE:
								client.kill()
								break
							default:
								break
						}
						self.reset()
					}}
				/>
				<image
					halign={CENTER}
					valign={CENTER}
					iconName={createBinding(client, "class")}
					useFallback
				/>
				<box class="focused"
					$type="overlay"
					visible={focused}
					halign={CENTER}
					valign={START}
				/>
			</overlay>
		)
	}

	const clients = createBinding(hypr, "clients").as(clients =>
		[...(clients ?? [])]
			.filter((c): c is AstalHyprland.Client => c != null)
			.sort((a, b) => (a?.workspace?.id ?? 0) - (b?.workspace?.id ?? 0))
	)

	return (
		<box class="tasks horizontal">
			<For each={clients}>
				{(app: AstalHyprland.Client) => <Entry client={app} />}
			</For>
		</box>
	)
}

export function Media() {
	const { END } = Pango.EllipsizeMode
	const [reveal, set_reveal] = createState(false)

	let trackTime: Timer | undefined = undefined

	onCleanup(() => {
		if (trackTime) {
			trackTime.cancel()
			trackTime = undefined
		}
	})

	const player = createComputed([createBinding(media, "players"), preferred], (ps, pref) => {
		return ps.find(p => p.get_bus_name().includes(pref)) || ps[0]
	})

	return (
		<box visible={player.as(p => p != null)}>
			<With value={player}>
				{p => {
					if (!p) return <box visible={false} />
					return (
						<PanelButton
							visible
							name="media"
							onClicked={() => p.get_playback_status() === PLAYING ? p.pause() : p.play()}
						>
							<box class="test">
								<Gtk.EventControllerMotion
									onLeave={() => set_reveal(false)}
									onEnter={() => {
										trackTime?.cancel()
										set_reveal(true)
									}}
								/>
								<image valign={CENTER} iconName={
									createBinding(p, "entry").as(e => e || "audio-x-generic-symbolic")
								} useFallback />
								<revealer
									transitionType={SLIDE_LEFT}
									revealChild={reveal}
									$={self => {
										let current = ""

										p.connect("notify::title", () => {
											if (current !== p.get_title()) {
												current = p.get_title()
												set_reveal(true)

												if (trackTime) {
													trackTime.cancel()
												}

												trackTime = timeout(options.notifications.dismiss.get(), () => {
													if (!self.in_destruction()) {
														set_reveal(false)
													}
													trackTime = undefined
												})
											}
										})
									}}
								>
									<label valign={CENTER} ellipsize={END} maxWidthChars={45} label={
										createComputed([createBinding(p, "title"), createBinding(p, "artist")], (title, artist) => {
											return `${title || "Untitled"}${artist ? ` - ${artist}` : ""}`
										})
									} />
								</revealer>
							</box>
						</PanelButton>
					)
				}}
			</With >
		</box>
	)
}

export function ScreenRecord() {
	return (
		<PanelButton class="recorder" visible={createBinding(scr, "recording")} onClicked={() => scr.stopRecord()}>
			<box class="horizontal">
				<image iconName={icons.recorder.recording} />
				<label label={createBinding(scr, "timer").as(v => duration(v) + " ")} />
			</box>
		</PanelButton>
	)
}

export function ColorPicker() {
	const colors = createBinding(cpick, "colors")

	const cssCache = new Map<string, string>()
	const css = (color: string) => {
		if (!cssCache.has(color)) {
			cssCache.set(color, `
				* {
					background-color: ${color};
					color: transparent;
				}
				*:hover {
					color: white;
					text-shadow: 2px 2px 3px rgba(0,0,0,.8);
				}`)
		}
		return cssCache.get(color)!
	}

	const [revealed, set_revealed] = createState(false)

	const popover = <Gtk.Popover
		hasArrow={false}
		position={Gtk.PositionType.BOTTOM}
		onShow={() => set_revealed(true)}
		onHide={() => set_revealed(false)}
	/> as Gtk.Popover

	popover.set_child(
		<revealer
			revealChild={revealed}
			transitionDuration={options.transition.duration}
			transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
		>
			<box class="colorpicker vertical" orientation={VERTICAL}>
				<For each={colors}>
					{color => (
						<button label={color} css={css(color)}
							onClicked={() => {
								cpick.pick(color)
								popover.popdown()
							}}
						/>
					)}
				</For>
			</box>
		</revealer> as Gtk.Revealer
	)

	return (
		<PanelButton name="color-picker"
			tooltipText={createBinding(cpick, "colors").as(v =>
				`${v.length} color${v.length === 1 ? "" : "s"}`)}

			$={self => {
				popover.set_parent(self)
			}}
		>
			<Gtk.GestureClick
				button={0}
				onEnd={self => {
					const btn = self.get_current_button()
					if (btn === Gdk.BUTTON_PRIMARY) {
						cpick.pick()
					}
					else if (cpick.colors.length > 0 && btn === Gdk.BUTTON_SECONDARY) {
						popover.popup()
					}
					self.reset()
				}}
			/>
			<image iconName={icons.ui.colorpicker} useFallback />
		</PanelButton >
	)
}
