import { Gdk, Gtk } from "ags/gtk4"
import { timeout, Timer } from "ags/time"
import { Accessor, createBinding, createComputed, createState, For, With } from "ags"

import AstalTray from "gi://AstalTray"
import AstalNetwork from "gi://AstalNetwork"
import AstalWp from "gi://AstalWp"
import AstalHyprland from "gi://AstalHyprland"
import AstalMpris from "gi://AstalMpris"
import Pango from "gi://Pango"

import PanelButton from "./PanelButton"

import { asusctl, audio, bt, cpick, hypr, media, net, notifd, pp, scr, tray } from "$lib/services"
import icons from "$lib/icons"
import { bashSync, duration, lookupIconName, toggleWindow } from "$lib/utils"

import options from "options"

const { exclusive } = options.bar.taskbar
const { preferred } = options.bar.media

const { CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

export function Tray() {
	const items = createComputed([createBinding(tray, "items"), options.bar.systray.ignore], (items, ignore) => {
		return items.filter(i => !ignore.includes(i.get_title()) && i.get_gicon())
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
	function AppItem({ app }: { app: AstalHyprland.Client }) {
		if (!app || app.class === "") {
			return <box visible={false} />
		}

		const visible = createComputed([createBinding(app, "workspace"), createBinding(hypr, "focusedWorkspace"), exclusive], (w, focused, exclusive) => {
			if (exclusive) {
				return w.id == focused.id
			}
			return true
		})

		const focused = createBinding(hypr, "focusedClient").as(v => {
			return v && v.address == app.address
		})

		return (
			<overlay class="panel-button" tooltipText={createBinding(app, "title")} visible={visible}>
				<Gtk.GestureClick
					button={0}
					onPressed={self => {
						const mBtn = self.get_current_button()
						switch (mBtn) {
							case Gdk.BUTTON_PRIMARY:
								app.focus()
								break
							case Gdk.BUTTON_SECONDARY:
								app.focus()
								hypr.message("dispatch fullscreen")
								break
							case Gdk.BUTTON_MIDDLE:
								app.kill()
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
					iconName={createBinding(app, "class")}
					useFallback
				/>
				<box class="focused"
					$type="overlay"
					visible={focused}
					halign={CENTER}
					valign={END}
				/>
			</overlay>
		)
	}

	return (
		<box class="tasks">
			<For each={createBinding(hypr, "clients").as(v =>
				[...(v ?? [])]                 // ensure v is at least an empty array
					.filter((c): c is AstalHyprland.Client => c != null) // remove nulls
					.sort((a, b) => (a.workspace?.id ?? 0) - (b.workspace?.id ?? 0)) // safe access
			)}>
				{(app: AstalHyprland.Client) => <AppItem app={app} />}
			</For>
		</box>
	)
}

export function Media() {
	const { PLAYING } = AstalMpris.PlaybackStatus
	const { SLIDE_LEFT } = Gtk.RevealerTransitionType
	const { END } = Pango.EllipsizeMode
	const [reveal, set_reveal] = createState(false)

	let trackTime: Timer | undefined = undefined

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
							class="media"
							onClicked={() => p.get_playback_status() === PLAYING ? p.pause() : p.play()}
						>
							<box class="horizontal">
								<image valign={CENTER} iconName={
									createBinding(p, "entry").as(e => e && lookupIconName(e) ? e : "audio-x-generic-symbolic")
								} useFallback />
								<Gtk.EventControllerMotion
									onLeave={() => set_reveal(false)}
									onEnter={() => {
										trackTime?.cancel()
										set_reveal(true)
									}}
								/>
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
		<PanelButton class="recorder horizontal" visible={createBinding(scr, "recording")} onClicked={() => scr.stopRecord()}>
			<box class="horizontal">
				<image iconName={icons.recorder.recording} />
				<label label={createBinding(scr, "timer").as(v => duration(v) + " ")} />
			</box>
		</PanelButton>
	)
}

export function ColorPicker() {
	const colors = createBinding(cpick, "colors")

	const css = (color: string) => `
		* {
				background-color: ${color};
				color: transparent;
		}
		*:hover {
				color: white;
				text-shadow: 2px 2px 3px rgba(0,0,0,.8);
		}`

	const popover = <Gtk.Popover hasArrow={false} position={Gtk.PositionType.BOTTOM} /> as Gtk.Popover
	// TODO: Animate
	popover.set_child(
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
		</box> as Gtk.Box
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

export function SysIndicators() {
	function CurrentLayout() {
		const ISO639 = {
			"abkh": "ab",		// Abkhazian
			"astu": "ast",	// Asturian
			"avat": "avt",	// Avatime
			"akan": "ak",		// Akan
			"alba": "sq",		// Albanian
			"arme": "hy",		// Armenian
			"bamb": "bm",		// Bambara
			"banb": "bn",		// Bangla
			"berb": "ber",	// Berber
			"bosn": "bs",		// Bosnian
			"bulg": "bg",		// Bulgarian
			"burm": "my",		// Burmese
			"cher": "chr",	// Cherokee
			"chin": "zh",		// Chinese
			"chuv": "cv",		// Chuvash
			"crim": "crh",	// Crimean Tatar
			"croa": "hr",		// Croatian
			"czec": "cs",		// Czech
			"dari": "prs",	// Dari
			"dhiv": "dv",		// Dhivehi
			"dutc": "nl",		// Dutch
			"esper": "eo",	// Esperanto
			"esto": "et",		// Estonian
			"ewe": "ee",		// Ewe
			"faro": "fo",		// Faroese
			"fili": "fil",  // Filipino
			"friu": "fur",	// Friulian
			"fula": "ff",		// Fulah
			"ga": "gaa",		// Ga
			"gaga": "gag",	// Gagauz
			"geor": "ka",		// Georgian
			"germ": "de",		// German
			"gree": "el",		// Greek
			"igbo": "ig",		// Igbo
			"icel": "is",		// Icelandic
			"ido": "io",		// Ido
			"indo": "id",		// Indonesian
			"inuk": "iu",		// Inuktitut
			"iris": "ga",		// Irish
			"java": "jv",		// Javanese
			"kann": "kn",		// Kannada
			"kanu": "kr",		// Kanuri
			"kash": "ks",		// Kashmiri
			"kaza": "kk",		// Kazakh
			"khme": "km",		// Khmer
			"kiku": "ki",		// Kikuyu
			"kiny": "rw",		// Kinyarwanda
			"kirg": "ky",		// Kirghiz
			"komi": "kv",		// Komi
			"kurd": "ku",		// Kurdish
			"lao": "lo",		// Lao
			"latv": "lv",		// Latvian
			"lith": "lt",		// Lithuanian
			"mace": "mk",		// Macedonian
			"malt": "mt",		// Maltese
			"maor": "mi",		// Maori
			"mara": "mr",		// Marathi
			"mong": "mn",		// Mongolian
			"nort": "se",		// Northern Sami
			"port": "pt",		// Portuguese
			"yaku": "sah",	// Yakut
		}

		function getLayout() {
			const layout = bashSync("hyprctl devices | awk '/active keymap:/{a[$3]++} END{min=NR; for(layout in a) if(a[layout]<min){min=a[layout]; minlayout=layout} print minlayout}'")
				.toLowerCase()

			if (layout == "malagasy") return "mg"
			if (layout == "malay") return "ms"
			if (layout == "malayalam") return "ml"

			// @ts-ignore: Valid keys
			return ISO639[layout.slice(0, 4)] || layout.slice(0, 2)
		}

		const [layout, set_layout] = createState(getLayout())
		hypr.connect("keyboard-layout", () => set_layout(getLayout()))
		return <label label={layout} />
	}

	function ProfileState() {
		const visible = asusctl.available
			? createBinding(asusctl, "profile").as(p => p !== "Balanced")
			: pp.get_version() ? createBinding(pp, "active_profile").as(p => p !== "balanced") : false

		const icon = asusctl.available
			// @ts-ignore: Valid keys
			? createBinding(asusctl, "profile").as((p: string) => icons.asusctl.profile[p])
			: pp.get_version() ? createBinding(pp, "active_profile").as((p: string) => icons.powerprofile[p as "balanced" | "power-saver" | "performance"]) : ""

		return <image iconName={icon} visible={visible} useFallback />
	}

	function AsusModeIndicator() {
		if (!asusctl.available) return <image visible={false} useFallback />
		const mode = createBinding(asusctl, "mode")
		return (
			<image
				// @ts-ignore: Valid keys
				iconName={mode.as(m => icons.asusctl.mode[m])}
				visible={mode.as(m => m !== "Hybrid")}
				useFallback
			/>
		)
	}

	function BtState() {
		const hasConnected = createBinding(bt, "isConnected")
		const isPowered = createBinding(bt, "isPowered")

		return (
			<image class={hasConnected.as(v => v ? "bluetooth-connected" : "")} visible={isPowered} iconName={icons.bluetooth.enabled} useFallback />
		)
	}

	function NetworkState() {
		const { WIRED, WIFI } = AstalNetwork.Primary

		const primary = createBinding(net, "primary")
		const connectivity = createBinding(net, "connectivity")
		const wifiAdapter = createBinding(net, "wifi")
		const wiredAdapter = createBinding(net, "wired")

		// TODO: Wifi strength doesn't update, it's just hacky
		const icon = createComputed(
			[primary, wifiAdapter, wiredAdapter, connectivity],
			(t, wifi, wired) => t === WIFI ? wifi.iconName : (t === WIRED ? wired.iconName : "")
		)

		return (
			<image
				iconName={icon}
				visible={icon.as(i => i !== "")}
				useFallback
			/>
		)
	}

	function DndState() {
		return (
			<image
				iconName={icons.notifications.silent}
				visible={createBinding(notifd, "dontDisturb")}
				useFallback
			/>
		)
	}

	function EndpointIcon({ binding }: { binding: Accessor<AstalWp.Endpoint | null> }) {
		return (
			<With value={binding}>
				{(ep: AstalWp.Endpoint | null) =>
					ep
						? <image iconName={createBinding(ep, "volumeIcon")} useFallback />
						: <box visible={false} />
				}
			</With>
		)
	}

	const SpkrState = () =>
		<EndpointIcon binding={createBinding(audio, "defaultSpeaker")} />

	const MicState = () =>
		<EndpointIcon binding={createBinding(audio, "defaultMicrophone")} />

	return (
		<PanelButton
			name="quicksettings"
			onClicked={() => toggleWindow("quicksettings")}
		>
			<Gtk.EventControllerScroll
				flags={Gtk.EventControllerScrollFlags.VERTICAL}
				onScroll={(_: any, __: number, dy: number) => {
					const spkr = audio?.get_default_speaker()
					if (spkr) {
						const current = spkr.get_volume() ?? 0
						spkr.set_volume(Math.min(1, Math.max(0, current - dy * 0.025)))
					}
					return true
				}}
			/>
			<box class="horizontal">
				<CurrentLayout />
				<ProfileState />
				<NetworkState />
				<BtState />
				<AsusModeIndicator />
				<SpkrState />
				<MicState />
				<DndState />
			</box>
		</PanelButton>
	)
}
