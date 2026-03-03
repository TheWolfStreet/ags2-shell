import { Gdk, Gtk } from "ags/gtk4"
import { timeout, Timer, idle } from "ags/time"
import {
	createBinding,
	createComputed,
	createState,
	For,
	With,
	onCleanup,
	type Accessor,
} from "ags"

import AstalHyprland from "gi://AstalHyprland"
import AstalMpris from "gi://AstalMpris"
import Pango from "gi://Pango"
import { PanelButton } from "../PanelButton"
import { AnimatedPopover, type AnimatedPopoverImpl, createTrayMenuPopover } from "./TrayMenu"

import { cpick, hypr, media, scr, tray } from "$lib/services"
import icons from "$lib/icons"
import { formatClock, getClientTitle } from "$lib/utils"
import {
	createTaskItems,
	focusClientFullscreen,
	onClientClick,
} from "$lib/tasks"

import options from "options"

const { PLAYING } = AstalMpris.PlaybackStatus
const { SLIDE_LEFT, SLIDE_DOWN } = Gtk.RevealerTransitionType
const { EllipsizeMode } = Pango

const { CENTER, START } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { BOTTOM } = Gtk.PositionType

const { BUTTON_SECONDARY } = Gdk

export function Tray() {
	const items = createTrayItems()
	return (
		<box visible={items.as(value => value.length > 0)}>
			<For each={items}>
				{item => {
					const { popover, ensureBuilt } = createTrayMenuPopover(item)
					return (
						<button
							class="tray-item"
							valign={CENTER}
							halign={CENTER}
							$={self => popover.set_parent(self)}
							onClicked={() => {
								if (item.menuModel) {
									ensureBuilt()
									popover.popup()
								}
							}}
						>
							<image gicon={createBinding(item, "gicon")} useFallback />
						</button>
					)
				}}
			</For>
		</box>
	)
}

export function Tasks() {
	const items = createTaskItems()
	return (
		<box class="tasks horizontal">
			<For each={items}>
				{client => <TaskEntry client={client} />}
			</For>
		</box>
	)
}

export function Media() {
	const player = createPreferredPlayer()
	const { reveal, bindTrackTitle, onEnter, onLeave } = createMediaReveal()

	return (
		<box visible={player.as(value => value != null)}>
			<With value={player}>
				{currentPlayer => {
					if (!currentPlayer) {
						return <box visible={false} />
					}

					const label = createPlayerLabel(currentPlayer)
					const playerIcon = createPlayerIcon(currentPlayer)

					return (
						<PanelButton
							visible
							name="media"
							onClicked={() => {
								if (currentPlayer.get_playback_status() === PLAYING) {
									currentPlayer.pause()
								} else {
									currentPlayer.play()
								}
							}}
						>
							<box class="test">
								<Gtk.EventControllerMotion
									onLeave={onLeave}
									onEnter={onEnter}
								/>
								<image valign={CENTER} iconName={playerIcon} useFallback />
								<revealer
									transitionType={SLIDE_LEFT}
									revealChild={reveal}
									$={self => bindTrackTitle(self, currentPlayer)}
								>
									<label
										valign={CENTER}
										ellipsize={EllipsizeMode.END}
										maxWidthChars={45}
										label={label}
									/>
								</revealer>
							</box>
						</PanelButton>
					)
				}}
			</With>
		</box>
	)
}

export function ScreenRecord() {
	return (
		<PanelButton
			class="recorder"
			visible={createBinding(scr, "recording")}
			onClicked={() => scr.stopRecord()}
		>
			<box class="horizontal">
				<image iconName={icons.recorder.recording} />
				<label label={createBinding(scr, "timer").as(value => formatClock(value) + " ")} />
			</box>
		</PanelButton>
	)
}

export function ColorPicker() {
	const colors = createBinding(cpick, "colors")
	const popover = createColorPopover(colors)
	const tooltip = colors.as(value => `${value.length} color${value.length === 1 ? "" : "s"}`)

	return (
		<PanelButton
			tooltipText={tooltip}
			onClicked={() => cpick.pick()}
			$={self => {
				popover.set_parent(self)
			}}
		>
			<Gtk.GestureClick
				button={BUTTON_SECONDARY}
				onReleased={() => {
					if (cpick.colors.length > 0)
						idle(() => popover.popup())
				}}
			/>
			<image iconName={icons.ui.colorpicker} useFallback />
		</PanelButton>
	)
}

function createTrayItems() {
	const trayItems = createBinding(tray, "items")

	return createComputed(() => {
		const ignoreSet = new Set(options.bar.systray.ignore())
		return trayItems().filter(item => !ignoreSet.has(item.get_title()) && item.get_gicon())
	})
}

function TaskEntry({ client }: { client: AstalHyprland.Client }) {
	if (!client || client.class === "") {
		return <box visible={false} />
	}

	const focused = createBinding(hypr, "focusedClient").as(value => {
		return value?.address === client.address
	})

	return (
		<overlay tooltipText={getClientTitle(client)} valign={CENTER}>
			<Gtk.GestureClick
				button={0}
				onPressed={self => {
					const button = self.get_current_button()

					onClientClick(button, {
						primary: () => client.focus(),
						secondary: () => focusClientFullscreen(client),
						middle: () => client.kill(),
					})

					self.reset()
				}}
			/>
			<image
				halign={CENTER}
				valign={CENTER}
				iconName={createBinding(client, "class")}
				useFallback
			/>
			<box
				class="focused"
				$type="overlay"
				visible={focused}
				halign={CENTER}
				valign={START}
			/>
		</overlay>
	)
}

function createPreferredPlayer() {
	const players = createBinding(media, "players")

	return createComputed(() => {
		return players().find(player => {
			return player.get_bus_name().includes(options.bar.media.preferred())
		}) || players()[0]
	})
}

function createMediaReveal() {
	const [reveal, setReveal] = createState(false)

	let trackTime: Timer | undefined

	function cancelTrackTime() {
		if (trackTime) {
			trackTime.cancel()
			trackTime = undefined
		}
	}

	function hideRevealLater(revealer: Gtk.Revealer) {
		trackTime = timeout(options.notifications.dismiss.peek(), () => {
			if (!revealer.in_destruction()) {
				setReveal(false)
			}

			trackTime = undefined
		})
	}

	function bindTrackTitle(revealer: Gtk.Revealer, player: AstalMpris.Player) {
		let currentTitle = ""

		const conn = player.connect("notify::title", () => {
			const nextTitle = player.get_title()

			if (currentTitle === nextTitle) {
				return
			}

			currentTitle = nextTitle
			setReveal(true)

			cancelTrackTime()
			hideRevealLater(revealer)
		})

		onCleanup(() => {
			player.disconnect(conn)
		})
	}

	function onEnter() {
		cancelTrackTime()
		setReveal(true)
	}

	function onLeave() {
		setReveal(false)
	}

	onCleanup(() => {
		cancelTrackTime()
	})

	return {
		reveal,
		bindTrackTitle,
		onEnter,
		onLeave,
	}
}

function createPlayerLabel(player: AstalMpris.Player) {
	const title = createBinding(player, "title")
	const artist = createBinding(player, "artist")

	return createComputed(() => {
		const trackTitle = title() || "Untitled"
		const trackArtist = artist()

		return trackArtist ? `${trackTitle} - ${trackArtist}` : trackTitle
	})
}

function createPlayerIcon(player: AstalMpris.Player) {
	return createBinding(player, "entry").as(entry => entry || "audio-x-generic-symbolic")
}

function createColorCss() {
	const cssCache = new Map<string, string>()

	return (color: string) => {
		if (!cssCache.has(color)) {
			cssCache.set(color, `
				button {
					background-color: ${color};
					color: transparent;
					box-shadow:
						inset 0 0 0 var(--border-width) var(--border-color),
						var(--neu-button-highlight),
						var(--neu-button-shadow);
				}
				button:hover {
					background-color: ${color};
					color: white;
					text-shadow: 2px 2px 3px rgba(0,0,0,.8);
					box-shadow:
						inset 0 0 0 var(--border-width) var(--border-color),
						var(--neu-button-hover-highlight),
						var(--neu-button-hover-shadow);
				}
				button:active {
					background-color: ${color};
					box-shadow:
						inset 0 0 0 var(--border-width) var(--border-color),
						var(--neu-button-active-highlight),
						var(--neu-button-active-shadow);
				}
			`)
		}

		return cssCache.get(color)!
	}
}

function createColorPopover(colors: Accessor<string[]>) {
	const css = createColorCss()
	const popover = new AnimatedPopover() as AnimatedPopoverImpl
	popover.set_has_arrow(false)
	popover.set_position(BOTTOM)
	popover.set_focusable(false)

	popover.set_child(
		<revealer
			$={self => { popover.revealer = self }}
			focusable={false}
			transitionDuration={options.transition.duration}
			transitionType={SLIDE_DOWN}
			onNotifyChildRevealed={self => {
				if (!self.get_child_revealed() && !self.get_reveal_child())
					popover.performHide()
			}}
		>
			<box class="colorpicker vertical" orientation={VERTICAL} focusable={false}>
				<For each={colors}>
					{color => (
						<button
							label={color}
							css={css(color)}
							focusable={false}
							onClicked={() => {
								popover.get_root()?.set_focus(null)
								cpick.pick(color)
								popover.popdown()
							}}
						/>
					)}
				</For>
			</box>
		</revealer> as Gtk.Revealer,
	)

	return popover
}
