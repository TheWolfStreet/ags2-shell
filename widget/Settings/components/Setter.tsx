import { createComputed } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import GObject from "gi://GObject"
import Pango from "gi://Pango"

import icons from "$lib/icons"
import { attempt } from "$lib/result"
import { is_dialog_dismissed, read_value, type maybe_accessor } from "$lib/ui"
import { Opt } from "$shell/options"

const { CENTER } = Gtk.Align
const { FONT } = Gtk.FontLevel
const { RGBA } = Gdk
const { FontDescription, FontFamily, FontFace, SCALE } = Pango

type enum_value = string | number

export type setter_props = {
	opt: Opt<any>
	enums?: maybe_accessor<readonly enum_value[]>
}

type enum_setter_props = {
	opt: Opt<any>
	values: maybe_accessor<readonly enum_value[]>
}

function is_regular_font(item: GObject.Object) {
	if (item instanceof FontFamily) return true
	if (!(item instanceof FontFace)) return false
	const face_name = item.get_face_name().toLowerCase()
	return face_name === "regular" || face_name === "normal"
}

function create_font_dialog() {
	const filter = new Gtk.CustomFilter()
	filter.set_filter_func(is_regular_font)
	const dialog = new Gtk.FontDialog()
	dialog.set_filter(filter)
	return dialog
}

const font_dialog = create_font_dialog()

function channel_hex(channel: number) {
	return Math.round(255 * channel)
		.toString(16)
		.padStart(2, "0")
}

function to_hex({ red, green, blue }: Gdk.RGBA) {
	return `#${[red, green, blue].map(channel_hex).join("")}`
}

function EnumSetter({ opt, values }: enum_setter_props) {
	const available = createComputed(() => read_value(values).length > 0)
	const step = (dir: 1 | -1) => {
		const choices = read_value(values)
		if (!choices.length) return
		const current_index = choices.findIndex((value) => value === opt.peek())
		if (current_index < 0) {
			opt.set(choices[0])
			return
		}
		opt.set(choices[(current_index + dir + choices.length) % choices.length])
	}
	return (
		<box class="enum-setter">
			<label
				label={createComputed(() =>
					available() ? String(opt()) : "No enum values",
				)}
			/>
			<button sensitive={available} onClicked={() => step(-1)}>
				<image iconName={icons.ui.arrow.left} />
			</button>
			<button sensitive={available} onClicked={() => step(1)}>
				<image iconName={icons.ui.arrow.right} />
			</button>
		</box>
	)
}

function FontSetter({ opt }: { opt: Opt<any> }) {
	function store_font(self: Gtk.FontDialogButton) {
		const desc = self.get_font_desc()
		if (!desc) return
		opt.set(`${desc.get_family()} ${desc.get_size() / SCALE}`)
	}

	return (
		<Gtk.FontDialogButton
			class="setting-setter"
			valign={CENTER}
			tooltipText="Select a font"
			useSize
			level={FONT}
			dialog={font_dialog}
			fontDesc={createComputed(() =>
				FontDescription.from_string(String(opt())),
			)}
			onNotifyFontDesc={store_font}
		/>
	)
}

function ColorSetter({ opt }: { opt: Opt<any> }) {
	const dialog = new Gtk.ColorDialog()

	function choose_color(self: Gtk.Button) {
		const initial = new RGBA()
		initial.parse(String(opt.peek()))
		const root = self.get_root()
		dialog.choose_rgba(
			root instanceof Gtk.Window ? root : null,
			initial,
			null,
			(_source, result) => {
				const chosen = attempt(() =>
					opt.set(to_hex(dialog.choose_rgba_finish(result))),
				)
				if (!chosen.ok && !is_dialog_dismissed(chosen.err))
					console.error(
						"settings.color_dialog: Failed to choose color",
						chosen.err,
					)
			},
		)
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

export default function Setter({ opt, enums }: setter_props) {
	const editor = enums ? "enum" : opt.editor()

	switch (editor) {
		case "number": {
			const { min, max } = opt.bounds()
			return (
				<Gtk.SpinButton
					valign={CENTER}
					adjustment={
						new Gtk.Adjustment({
							lower: min,
							upper: max,
							stepIncrement: 1,
							pageIncrement: 5,
						})
					}
					numeric
					value={createComputed(() => Number(opt()))}
					onValueChanged={(self) => opt.set(self.value)}
				/>
			)
		}
		case "string":
			return (
				<entry
					valign={CENTER}
					tooltipText="Enter text"
					text={createComputed(() => String(opt()))}
					onNotifyText={(self) => opt.set(self.get_text())}
				/>
			)
		case "enum":
			return <EnumSetter opt={opt} values={enums ?? opt.choices() ?? []} />
		case "boolean":
			return (
				<switch
					valign={CENTER}
					state={createComputed(() => Boolean(opt()))}
					active={createComputed(() => Boolean(opt()))}
					onNotifyState={(self) => opt.set(self.get_state())}
				/>
			)
		case "font":
			return <FontSetter opt={opt} />
		case "color":
			return <ColorSetter opt={opt} />
	}
}
