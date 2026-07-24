// Shows the right editor for each setting and delays repeated saves while editing.

import { createComputed, onCleanup } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { attempt } from "$lib/result"
import { debounce } from "$lib/timing"

const { CENTER } = Gtk.Align
const { OPEN } = Gtk.FileChooserAction
const { ACCEPT } = Gtk.ResponseType
const { FONT } = Gtk.FontLevel
const { RGBA } = Gdk
const { FontDescription, FontFamily, FontFace, SCALE } = Pango

const NUMBER_UPDATE_DEBOUNCE_MS = 70
const TEXT_UPDATE_DEBOUNCE_MS = 180
const FONT_UPDATE_DEBOUNCE_MS = 120

type EnumValue = string | number

export type CommonOption = {
	(): unknown
	readonly id: string
	peek(): unknown
	set(value: unknown): void
	getDefault(): unknown
	reset(): void
}

export type EditorType =
	| "number"
	| "color"
	| "float"
	| "object"
	| "string"
	| "enum"
	| "boolean"
	| "img"
	| "font"

type SetterProps = {
	opt: CommonOption
	type?: EditorType
	enums?: readonly EnumValue[]
	max?: number
	min?: number
}

type EnumSetterProps = {
	opt: CommonOption
	values: readonly EnumValue[]
}

function resolveSetterType(opt: SetterProps["opt"], type: SetterProps["type"]): EditorType {
	if (type) {
		return type
	}

	const valueType = typeof opt.peek()
	if (valueType === "boolean") return "boolean"
	if (valueType === "number") return "number"
	if (valueType === "string") return "string"
	return "object"
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
		const currentIndex = values.findIndex(value => value === opt.peek())
		const nextIndex = dir > 0
			? (currentIndex + 1) % values.length
			: (currentIndex - 1 + values.length) % values.length
		opt.set(values[nextIndex])
	}
	return (
		<box class="enum-setter">
			<label label={createComputed(() => String(opt()))} />
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
			const update = debounce<[number]>(NUMBER_UPDATE_DEBOUNCE_MS, value => {
				opt.set(value)
			})

			onCleanup(update.cancel)

			return (
				<Gtk.SpinButton
					valign={CENTER}
					adjustment={new Gtk.Adjustment({ lower: min, upper: max, stepIncrement: 1, pageIncrement: 5 })}
					numeric
					value={createComputed(() => Number(opt()))}
					onValueChanged={self => {
						update.call(self.value)
					}
					}
				/>
			)
		}
		case "float":
		case "object": {
			const update = debounce<[string]>(TEXT_UPDATE_DEBOUNCE_MS, (text) => {
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
					text={createComputed(() => JSON.stringify(opt(), null, 2))}
					onNotifyText={self => {
						update.call(self.get_text())
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
			const update = debounce<[string]>(TEXT_UPDATE_DEBOUNCE_MS, value => {
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
					text={createComputed(() => String(opt()))}
					onNotifyText={self => update.call(self.get_text())}
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
			if (!enums?.length)
				return <label label="No enum values" sensitive={false} />
			return <EnumSetter opt={opt} values={enums} />
		}
		case "boolean": {
			return (
				<switch
					valign={CENTER}
					state={createComputed(() => Boolean(opt()))}
					active={createComputed(() => Boolean(opt()))}
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
								if (filename)
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
			const update = debounce<[string]>(FONT_UPDATE_DEBOUNCE_MS, value => {
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
					fontDesc={createComputed(() => FontDescription.from_string(String(opt())))}
					onNotifyFontDesc={(self) => {
						const desc = self.get_font_desc()
						if (desc) {
							const family = desc.get_family()
							const size = desc.get_size() / SCALE
							update.call(`${family} ${size}`)
						}
					}}
				/>
			)
		}
		case "color": {
			const dialog = new Gtk.ColorDialog
			const chooseColor = (self: Gtk.Button) => {
				const initial = new RGBA()
				initial.parse(String(opt.peek()))
				const root = self.get_root()

				dialog.choose_rgba(root instanceof Gtk.Window ? root : null, initial, null, (_source, result) => {
					try {
						opt.set(toHex(dialog.choose_rgba_finish(result)))
					} catch {
						// Closing the dialog cancels the asynchronous selection.
					}
				})
			}

			return (
				<button
					class="color-setter"
					valign={CENTER}
					tooltipText={"Select a color"}
					onClicked={chooseColor}
				>
					<box
						class="color-swatch"
						css={createComputed(() => `background-color: ${String(opt())};`)}
					/>
				</button>
			)
		}
		default:
			return <label
				label={`[ERROR]: No setter with type ${resolvedType}`}
			/>
	}
}
