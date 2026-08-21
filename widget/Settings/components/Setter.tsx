// Shows the appropriate editor for each setting.

import { createComputed } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { attempt } from "$lib/result"
import { isDialogDismissed } from "$lib/ui"
import { Opt } from "$shell/options"

const { CENTER } = Gtk.Align
const { FONT } = Gtk.FontLevel
const { RGBA } = Gdk
const { FontDescription, FontFamily, FontFace, SCALE } = Pango

type EnumValue = string | number

export type EditorType =
	| "number"
	| "color"
	| "string"
	| "enum"
	| "boolean"
	| "font"

type SetterProps = {
	opt: Opt<any>
	type?: EditorType
	enums?: readonly EnumValue[]
	max?: number
	min?: number
}

type EnumSetterProps = {
	opt: Opt<any>
	values: readonly EnumValue[]
}

function resolveSetterType(opt: SetterProps["opt"], type: SetterProps["type"]): EditorType {
	if (type) {
		return type
	}

	const valueType = typeof opt.peek()
	if (valueType === "boolean") return "boolean"
	if (valueType === "number") return "number"
	return "string"
}

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
			return (
				<Gtk.SpinButton
					valign={CENTER}
					adjustment={new Gtk.Adjustment({ lower: min, upper: max, stepIncrement: 1, pageIncrement: 5 })}
					numeric
					value={createComputed(() => Number(opt()))}
					onValueChanged={self => opt.set(self.value)}
				/>
			)
		}
		case "string": {
			return (
				<entry
					valign={CENTER}
					tooltipText="Enter text"
					text={createComputed(() => String(opt()))}
					onNotifyText={self => opt.set(self.get_text())}
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
		case "font": {
			return (
				<Gtk.FontDialogButton
					class="setting-setter"
					valign={CENTER}
					tooltipText="Select a font"
					useSize={true}
					level={FONT}
					dialog={fontDialog}
					fontDesc={createComputed(() => FontDescription.from_string(String(opt())))}
					onNotifyFontDesc={(self) => {
						const desc = self.get_font_desc()
						if (desc) {
							const family = desc.get_family()
							const size = desc.get_size() / SCALE
							opt.set(`${family} ${size}`)
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
					const outcome = attempt(() => {
						opt.set(toHex(dialog.choose_rgba_finish(result)))
					})
					if (!outcome.ok && !isDialogDismissed(outcome.err))
						console.error("settings.color_dialog: Failed to choose color", outcome.err)
				})
			}

			return (
				<button
					class="color-setter"
					valign={CENTER}
					tooltipText="Select a color"
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
