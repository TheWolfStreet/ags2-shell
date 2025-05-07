import Network from "gi://AstalNetwork"
import { Astal, Gtk, Gdk, Widget } from "astal/gtk3"
import { bind, Variable } from "astal"

import { ColorPicker, Media, PendingNotifications, PowerButton, ScreenRecord, SysTray, Taskbar } from "./components/Buttons"
import { BatteryLevel } from "./components/BatteryState"
import { Workspaces } from "./components/Overview"
import { DateMenuBtn } from "./components/DateMenu"
import { LauncherBtn } from "./components/Launcher"
import PanelButton from "./components/PanelButton"

import { bashSync, initHook, onWindowToggle, toggleWindow } from "../../lib/utils"
import { asusctl, audio, bt, hypr, net, notifd, pp } from "../../lib/services"
import icons from "../../lib/icons"
import options from "../../options"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { START, CENTER, END } = Gtk.Align

export function SysIndicators() {
	const CurrentLayout = () => {
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

		const layout = Variable(getLayout())
		hypr.connect("keyboard-layout", () => layout.set(getLayout()))
		return <label label={layout()} />
	}

	const ProfileState = () => {
		const visible = asusctl.available
			? bind(asusctl, "profile").as(p => p !== "Balanced")
			: pp.available ? bind(pp, "active_profile").as(p => p !== "balanced") : false

		const icon = asusctl.available
			? bind(asusctl, "profile").as((p: "Performance" | "Balanced" | "Quiet") => icons.asusctl.profile[p])
			: pp.available ? bind(pp, "active_profile").as((p: string) => icons.powerprofile[p as "balanced" | "power-saver" | "performance"]) : ""

		return <icon icon={icon} visible={visible} useFallback />
	}

	const AsusModeIndicator = () => {
		if (!asusctl.available) return <icon visible={false} useFallback />
		const mode = bind(asusctl, "mode")
		return (
			<icon
				// @ts-ignore: Valid keys
				icon={mode.as(m => icons.asusctl.mode[m])}
				visible={mode.as(m => m !== "Hybrid")}
				useFallback
			/>
		)
	}

	const BtState = () => {
		const hasConnected = bind(bt, "isConnected")
		const isPowered = bind(bt, "isPowered")
		return (
			<box visible={isPowered}>
				<overlay
					className="bluetooth"
					passThrough
					child={<icon icon={icons.bluetooth.enabled} useFallback />}
					overlay={
						<box
							className="indicator"
							halign={CENTER}
							valign={START}
							visible={hasConnected}
						/>
					}
				/>
			</box>
		)
	}

	const NetworkState = () => {
		const { WIRED, WIFI } = Network.Primary
		// TODO: Make dynamic based on presence of wifi adapter
		const icon = Variable.derive([bind(net, "primary"), net.wifi ? bind(net.wifi, "iconName") : Variable("")(), net.wired ? bind(net.wired, "iconName") : Variable("")],
			(type, wifi, wired) => {
				return type === WIFI ? wifi : (type === WIRED ? wired : "")
			})

		return (
			<icon
				icon={icon()}
				visible={icon(i => i !== "")}
				useFallback
			/>
		)
	}

	const DndState = () =>
		<icon
			icon={icons.notifications.silent}
			visible={bind(notifd, "dontDisturb")}
			useFallback
		/>

	const SpkrState = () =>
		audio ? <icon icon={bind(audio.defaultSpeaker, "volumeIcon")} useFallback /> : <box visible={false} />

	const MicState = () =>
		audio ? <icon icon={bind(audio.defaultMicrophone, "volumeIcon")} useFallback /> : <box visible={false} />

	return (
		<PanelButton
			name="quicksettings"
			className="quicksettings"
			onClick={() => toggleWindow("quicksettings")}
			setup={self => {
				onWindowToggle(self, self.name, (w) => {
					self.toggleClassName("active", w.visible)
				})
			}}
			onScroll={(_: Widget.Button, event: Astal.ScrollEvent) => {
				const spkr = audio?.get_default_speaker()
				spkr?.set_volume((spkr.get_volume() ?? 0) - event.delta_y * 0.025)
			}}
		>
			<box className="horizontal">
				<CurrentLayout />
				<ProfileState />
				<AsusModeIndicator />
				<BtState />
				<NetworkState />
				<DndState />
				<SpkrState />
				<MicState />
			</box>
		</PanelButton>
	)
}

export default (monitor: Gdk.Monitor) =>
	<window
		className="bar"
		gdkmonitor={monitor}
		exclusivity={Astal.Exclusivity.EXCLUSIVE}
		setup={self =>
			initHook(self, options.bar.transparent, () => {
				self.toggleClassName("transparent", options.bar.transparent.get())
			})}
		anchor={options.bar.position(((pos) => pos === "top" ? (TOP | LEFT | RIGHT) : (BOTTOM | LEFT | RIGHT)))}>
		<centerbox>
			<box hexpand halign={START}>
				<LauncherBtn />
				<Workspaces />
				<Taskbar />
			</box>
			<box halign={CENTER}>
				<DateMenuBtn />
			</box>
			<box hexpand halign={END} >
				{Media()}
				<SysTray />
				<ColorPicker />
				<PendingNotifications />
				<ScreenRecord />
				<SysIndicators />
				<BatteryLevel />
				<PowerButton />
			</box>
		</centerbox>
	</window>
