import { onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { timeout, Timer } from "ags/time"

import { RowProps } from "./layout"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { Opt } from "$lib/option"
import { attempt } from "$lib/result"

const { CENTER } = Gtk.Align
const { OPEN } = Gtk.FileChooserAction
const { ACCEPT } = Gtk.ResponseType
const { FONT } = Gtk.FontLevel
const { RGBA } = Gdk
const { FontDescription, FontFamily, FontFace, SCALE } = Pango

const COLOR_UPDATE_DEBOUNCE_MS = 48
const NUMBER_UPDATE_DEBOUNCE_MS = 70
const TEXT_UPDATE_DEBOUNCE_MS = 180
const FONT_UPDATE_DEBOUNCE_MS = 120

type EnumValue = string | number

type EnumSetterProps = {
	opt: Opt<EnumValue>
	values: EnumValue[]
}

type SetterProps = Pick<RowProps, "opt" | "type" | "enums" | "max" | "min">

function resolveSetterType(opt: SetterProps["opt"], type: SetterProps["type"]): NonNullable<RowProps["type"]> {
	if (type) {
		return type
	}

	const valueType = typeof opt.peek()
	if (valueType === "boolean") return "boolean"
	if (valueType === "number") return "number"
	if (valueType === "string") return "string"
	return "object"
}

function createDebouncedSetter<T>(delayMs: number, setter: (value: T) => void) {
	let timer: Timer | null = null

	const cancel = () => {
		if (!timer)
			return

		timer.cancel()
		timer = null
	}

	const flush = (value: T) => {
		cancel()
		setter(value)
	}

	const schedule = (value: T) => {
		cancel()
		timer = timeout(delayMs, () => {
			timer = null
			setter(value)
		})
	}

	return { schedule, flush, cancel }
}

function tryParseJson(text: string) {
	return attempt(() => JSON.parse(text || ""))
}

const imageFilter = (() => {
	const filter = new Gtk.FileFilter()
	filter.add_mime_type("image/*")
	return filter
})()

const fontDialog = (() => {
	const filter = new Gtk.CustomFilter()
	filter.set_filter_func((item) => {
		if (item instanceof FontFamily) {
			return true
		}
		if (item instanceof FontFace) {
			const faceName = item.get_face_name().toLowerCase()
			return faceName === "regular" || faceName === "normal"
		}
		return false
	})
	const dialog = new Gtk.FontDialog
	dialog.set_filter(filter)
	return dialog
})()

const toHex = (rgba: Gdk.RGBA) => {
	const { red, green, blue } = rgba
	return `#${[red, green, blue]
		.map(n => Math.floor(255 * n).toString(16).padStart(2, "0"))
		.join("")}`
}

const EnumSetter = ({ opt, values }: EnumSetterProps) => {
	const step = (dir: 1 | -1) => {
		const i = values.findIndex(v => v === opt.peek())
		const nextIndex = dir > 0
			? (i + 1) % values.length
			: (i - 1 + values.length) % values.length
		opt.set(values[nextIndex])
	}
	return (
		<box class="enum-setter">
			<label label={opt.as(v => String(v))} />
			<button onClicked={() => step(-1)}>
				<image iconName={icons.ui.arrow.left} />
			</button>
			<button onClicked={() => step(1)}>
				<image iconName={icons.ui.arrow.right} />
			</button>
		</box>
	)
}

export default function Setter(props: SetterProps) {
	const { opt, type, enums, max = 1000, min = 0 } = props
	const resolvedType = resolveSetterType(opt, type)

	switch (resolvedType) {
		case "number": {
			const update = createDebouncedSetter<number>(NUMBER_UPDATE_DEBOUNCE_MS, value => {
				opt.set(value)
			})

			onCleanup(update.cancel)

			return (
				<Gtk.SpinButton
					valign={CENTER}
					adjustment={new Gtk.Adjustment({ lower: min, upper: max, stepIncrement: 1, pageIncrement: 5 })}
					numeric
					value={opt}
					onValueChanged={self => {
						update.schedule(self.value)
					}
					}
				/>
			)
		}
		case "float":
		case "object": {
			const update = createDebouncedSetter<string>(TEXT_UPDATE_DEBOUNCE_MS, (text) => {
				const parsed = tryParseJson(text)
				if (parsed.ok) {
					opt.set(parsed.value)
				}
			})

			onCleanup(update.cancel)

			const commitText = (self: Gtk.Entry) => {
				const text = self.get_text()
				const parsed = tryParseJson(text)
				if (parsed.ok) {
					update.cancel()
					opt.set(parsed.value)
					return
				}

				self.set_text(JSON.stringify(opt.peek(), null, 2))
			}

			return (
				<entry
					valign={CENTER}
					text={opt.as(t => JSON.stringify(t, null, 2))}
					onNotifyText={self => {
						update.schedule(self.get_text())
					}}
					onActivate={commitText}
					onNotifyHasFocus={self => {
						if (!self.has_focus) {
							commitText(self)
						}
					}}
				/>
			)
		}
		case "string": {
			const update = createDebouncedSetter<string>(TEXT_UPDATE_DEBOUNCE_MS, value => {
				opt.set(value)
			})

			onCleanup(update.cancel)

			const commitText = (self: Gtk.Entry) => {
				update.flush(self.get_text())
			}

			return (
				<entry
					valign={CENTER}
					tooltipText={"Enter text"}
					text={opt}
					onNotifyText={self => update.schedule(self.get_text())}
					onActivate={commitText}
					onNotifyHasFocus={self => {
						if (!self.has_focus) {
							commitText(self)
						}
					}}
				/>
			)
		}
		case "enum": {
			return <EnumSetter opt={opt} values={enums!} />
		}
		case "boolean": {
			return (
				<switch
					valign={CENTER}
					state={opt}
					active={opt}
					onNotifyState={self => opt.set(self.get_state())}
				/>
			)
		}
		case "img": {
			return (
				<Gtk.Button
					valign={CENTER}
					label="Select an image"
					tooltipText="Select an image"
					onClicked={() => {
						const chooser = new Gtk.FileChooserNative({
							title: "Select an image",
							action: OPEN,
							acceptLabel: "_Open",
							cancelLabel: "_Cancel"
						})
						chooser.add_filter(imageFilter)

						chooser.connect("response", (dialog, response) => {
							if (response === ACCEPT) {
								const filename = chooser.get_file()?.get_path()
								opt.set(filename)
							}
							dialog.destroy()
						})

						chooser.show()
					}}
				/>
			)
		}
		case "font": {
			const update = createDebouncedSetter<string>(FONT_UPDATE_DEBOUNCE_MS, value => {
				opt.set(value)
			})

			onCleanup(update.cancel)

			return (
				<Gtk.FontDialogButton
					valign={CENTER}
					tooltipText={"Select a font"}
					useSize={true}
					level={FONT}
					dialog={fontDialog}
					fontDesc={opt.as(v => FontDescription.from_string(String(v)))}
					onNotifyFontDesc={(self) => {
						const desc = self.get_font_desc()
						if (desc) {
							const family = desc.get_family()
							const size = desc.get_size() / SCALE
							update.schedule(`${family} ${size}`)
						}
					}}
				/>
			)
		}
		case "color": {
			const update = createDebouncedSetter<string>(COLOR_UPDATE_DEBOUNCE_MS, value => {
				opt.set(value)
			})

			onCleanup(update.cancel)

			return (
				<Gtk.ColorDialogButton
					valign={CENTER}
					tooltipText={"Select a color"}
					dialog={new Gtk.ColorDialog}
					onNotifyRgba={self => {
						update.schedule(toHex(self.get_rgba()))
					}}
					rgba={opt.as(v => {
						const color = new RGBA()
						color.parse(v as string)
						return color
					})}
				/>
			)
		}
		default:
			return <label
				label={`[ERROR]: No setter with type ${resolvedType}`}
			/>
	}
}
