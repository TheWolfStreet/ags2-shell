import Cairo10 from "gi://cairo"
import { timeout, Variable } from "astal"
import { App, Gtk, Gdk, Astal } from "astal/gtk3"
import { AspectFrame, ProgressBar } from "../GtkWidgets"

import { audio, brightness } from "../../lib/services"
import options from "../../options"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { CENTER, END } = Gtk.Align
const { SLIDE_UP } = Gtk.RevealerTransitionType

function OSDProgress() {
	const visible = Variable(false)
	const iconName = Variable("")
	const value = Variable(0)

	const spkr = audio?.get_default_speaker()
	const mic = audio?.get_default_microphone()

	let count = 0
	function show(v: number, icon: string) {
		visible.set(true)
		value.set(v)
		iconName.set(icon)
		count++
		timeout(options.notifications.dismiss.get() / 3, () => {
			count--
			if (count === 0) visible.set(false)
		})
	}

	return (
		<revealer
			setup={self => {
				self.hook(brightness, "notify::display", () =>
					show(brightness.display, brightness.displayIcon)
				)

				self.hook(brightness, "notify::kbd", () =>
					show(brightness.kbd, brightness.kbdIcon)
				)
				if (spkr) {
					self.hook(spkr, "notify::volume", () =>
						show(spkr.volume, spkr.volumeIcon)
					)
					self.hook(spkr, "notify::mute", () => {
						show(spkr.volume, spkr.volumeIcon)
					}
					)
				}
				if (mic) {
					self.hook(mic, "notify::volume", () =>
						show(mic.volume, mic.volumeIcon)
					)

					self.hook(mic, "notify::mute", () =>
						show(mic.volume, mic.volumeIcon)
					)
				}
			}
			}
			revealChild={visible()}
			transitionType={SLIDE_UP}
		>
			<AspectFrame className="audio-state" obeyChild={false} ratio={1}>
				<box vertical>
					<icon icon={iconName()} useFallback />
					<ProgressBar fraction={value()} />
				</box>
			</AspectFrame>
		</revealer>
	)
}

export default (monitor: Gdk.Monitor) =>
	<window
		name={`indicator${monitor}`}
		className="indicator"
		gdkmonitor={monitor}
		clickThrough
		application={App}
		layer={Astal.Layer.OVERLAY}
		setup={self => self.input_shape_combine_region(new Cairo10.Region)}
		anchor={TOP | BOTTOM | LEFT | RIGHT}
	>
		<box valign={END} halign={CENTER}>
			<OSDProgress />
		</box>
	</window>
