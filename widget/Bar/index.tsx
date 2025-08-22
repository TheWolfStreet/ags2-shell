import { createState, createBinding, createComputed } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"

import AstalNetwork from "gi://AstalNetwork"

import { PowerButton } from "widget/PowerMenu"
import Clock from "./components/Clock"
import Battery from "./components/Battery"
import { Launcher } from "./components/Launcher"
import QuickSettings from "./components/QuickSettings"
import PanelButton from "./components/PanelButton"

import { bashSync, toggleWindow } from "$lib/utils"
import { asusctl, audio, bt, hypr, net, notifd, pp } from "$lib/services"
import icons from "$lib/icons"

import options from "options"

function SysIndicators() {
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

		const [layout, set_layout] = createState(getLayout())
		hypr.connect("keyboard-layout", () => set_layout(getLayout()))
		return <label label={layout} />
	}

	const ProfileState = () => {
		const visible = asusctl.available
			? createBinding(asusctl, "profile").as(p => p !== "Balanced")
			: pp.get_version() ? createBinding(pp, "active_profile").as(p => p !== "balanced") : false

		const icon = asusctl.available
			// @ts-ignore: Valid keys
			? createBinding(asusctl, "profile").as((p: string) => icons.asusctl.profile[p])
			: pp.get_version() ? createBinding(pp, "active_profile").as((p: string) => icons.powerprofile[p as "balanced" | "power-saver" | "performance"]) : ""

		return <image iconName={icon} visible={visible} useFallback />
	}

	const AsusModeIndicator = () => {
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

	const BtState = () => {
		const hasConnected = createBinding(bt, "isConnected")
		const isPowered = createBinding(bt, "isPowered")

		return (
			<image class={hasConnected.as(v => v ? "bluetooth-connected" : "")} visible={isPowered} iconName={icons.bluetooth.enabled} useFallback />
		)
	}

	const NetworkState = () => {
		const { WIRED, WIFI } = AstalNetwork.Primary
		// TODO: Make dynamic based on presence of wifi adapter
		const icon = createComputed([createBinding(net, "primary"), createBinding(net.wifi, "iconName"), createBinding(net.wired, "iconName")],
			(type, wifi, wired) => {
				return type === WIFI ? wifi : (type === WIRED ? wired : "")
			})

		return (
			<image
				iconName={icon}
				visible={icon.as((i: string) => i !== "")}
				useFallback
			/>
		)
	}

	const DndState = () =>
		<image
			iconName={icons.notifications.silent}
			visible={createBinding(notifd, "dontDisturb")}
			useFallback
		/>

	const SpkrState = () =>
		audio ? <image iconName={createBinding(audio.defaultSpeaker, "volumeIcon")} useFallback /> : <box visible={false} />

	const MicState = () =>
		audio ? <image iconName={createBinding(audio.defaultMicrophone, "volumeIcon")} useFallback /> : <box visible={false} />

	return (
		<PanelButton
			name="quicksettings"
			onClicked={() => toggleWindow("quicksettings")}
			$={() => {
				app.add_window(QuickSettings() as Gtk.Window)
			}}
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

export default function Bar(gdkmonitor: Gdk.Monitor) {
	const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

	return (
		<window
			visible
			name="bar"
			class="bar"
			gdkmonitor={gdkmonitor}
			exclusivity={Astal.Exclusivity.EXCLUSIVE}
			anchor={
				options.bar.position.as((pos: string) => {
					const vertical = pos === 'top' ? TOP : pos === 'bottom' ? BOTTOM : TOP
					return vertical | LEFT | RIGHT
				})
			}
			application={app}
		>
			<centerbox>
				<box $type="start">
					<Launcher />
				</box>

				<box $type="center">
					<Clock />
				</box>

				<box $type="end">
					<SysIndicators />
					<Battery />
					<PowerButton />
				</box>
			</centerbox>
		</window >
	)
}
