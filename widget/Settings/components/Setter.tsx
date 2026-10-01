
import { Accessor, createComputed } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { attempt } from "$lib/result"
import { is_dialog_dismissed } from "$lib/ui"
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
	enums?: readonly EnumValue[] | Accessor<readonly EnumValue[]>
	max?: number
	min?: number
}

type EnumSetterProps = {
	opt: Opt<any>
	values: readonly EnumValue[] | Accessor<readonly EnumValue[]>
}

function resolve_setter_type(opt: SetterProps["opt"], type: SetterProps["type"]): EditorType {
	if (type) {
		return type
	}

	const value_type = typeof opt.peek()
	if (value_type === "boolean") return "boolean"
	if (value_type === "number") return "number"
	return "string"
}

const font_dialog = (() => {
	const filter = new Gtk.CustomFilter()
	filter.set_filter_func((item) => {
		if (item instanceof FontFamily) {
			return true
		}
		if (item instanceof FontFace) {
			const face_name = item.get_face_name().toLowerCase()
			return face_name === "regular" || face_name === "normal"
		}
		return false
	})
	const dialog = new Gtk.FontDialog
	dialog.set_filter(filter)
	return dialog
})()

const to_hex = (rgba: Gdk.RGBA) => {
	const { red, green, blue } = rgba
	return `#${[red, green, blue]
		.map(n => Math.round(255 * n).toString(16).padStart(2, "0"))
		.join("")}`
}

const EnumSetter = ({ opt, values }: EnumSetterProps) => {
	const available = createComputed(() => (values instanceof Accessor ? values() : values).length > 0)
	const step = (dir: 1 | -1) => {
		const choices = values instanceof Accessor ? values.peek() : values
		if (!choices.length) return
		const current_index = choices.findIndex(value => value === opt.peek())
		if (current_index < 0) {
			opt.set(choices[0])
			return
		}
		const next_index = dir > 0
			? (current_index + 1) % choices.length
			: (current_index - 1 + choices.length) % choices.length
		opt.set(choices[next_index])
	}
	return (
		<box class="enum-setter">
			<label label={createComputed(() => available() ? String(opt()) : "No enum values")} />
			<button sensitive={available} onClicked={() => step(-1)}>
				<image iconName={icons.ui.arrow.left} />
			</button>
			<button sensitive={available} onClicked={() => step(1)}>
				<image iconName={icons.ui.arrow.right} />
			</button>
		</box>
	)
}

export default function Setter(props: SetterProps) {
	const { opt, type, enums, max = 1000, min = 0 } = props
	const resolved_type = resolve_setter_type(opt, type)

	switch (resolved_type) {
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
			return <EnumSetter opt={opt} values={enums ?? []} />
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
					dialog={font_dialog}
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
			const choose_color = (self: Gtk.Button) => {
				const initial = new RGBA()
				initial.parse(String(opt.peek()))
				const root = self.get_root()

				dialog.choose_rgba(root instanceof Gtk.Window ? root : null, initial, null, (_source, result) => {
					const outcome = attempt(() => {
						opt.set(to_hex(dialog.choose_rgba_finish(result)))
					})
					if (!outcome.ok && !is_dialog_dismissed(outcome.err))
						console.error("settings.color_dialog: Failed to choose color", outcome.err)
				})
			}

			return (
				<button
					class="color-setter"
					valign={CENTER}
					tooltipText="Select a color"
					onClicked={choose_color}
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
				label={`[ERROR]: No setter with type ${resolved_type}`}
			/>
	}
}
