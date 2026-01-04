import { Gdk, Gtk } from "ags/gtk4"

import { RowProps } from "./Row"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { Opt } from "$lib/option"

const { CENTER } = Gtk.Align

const imageFilter = (() => {
	const filter = new Gtk.FileFilter()
	filter.add_mime_type('image/*')
	return filter
})()

const toHex = (rgba: Gdk.RGBA) => {
	const { red, green, blue } = rgba
	return `#${[red, green, blue]
		.map(n => Math.floor(255 * n).toString(16).padStart(2, '0'))
		.join('')}`
}

const EnumSetter = (opt: Opt<string>, values: string[]) => {
	const step = (dir: 1 | -1) => {
		const i = values.findIndex(v => v === opt.peek())
		const nextIndex = dir > 0
			? (i + 1) % values.length
			: (i - 1 + values.length) % values.length
		opt.set(values[nextIndex])
	}
	return (
		<box class="enum-setter">
			<label label={opt} />
			<button onClicked={() => step(-1)}>
				<image iconName={icons.ui.arrow.left} />
			</button>
			<button onClicked={() => step(1)}>
				<image iconName={icons.ui.arrow.right} />
			</button>
		</box>
	)
}

export default function Setter({ opt, type, enums, max = 1000, min = 0,
}: RowProps) {
	if (!type) {
		const value = opt.peek()
		const valueType = typeof value

		if (valueType === "boolean") type = "boolean"
		else if (valueType === "number") type = "number"
		else if (valueType === "string") type = "string"
		else type = "object"
	}
	switch (type) {
		case "number": {
			return (
				<Gtk.SpinButton
					valign={CENTER}
					adjustment={new Gtk.Adjustment({ lower: min, upper: max, stepIncrement: 1, pageIncrement: 5 })}
					numeric
					value={opt}
					onNotifyValue={self => opt.set(self.value)}
				/>
			)
		}
		case "float":
		case "object": {
			return (
				<entry
					valign={CENTER}
					text={opt.as(t => JSON.stringify(t, null, 2))}
					onNotifyText={self => {
						try {
							opt.set(JSON.parse(self.text || ""))
						} catch (e) {
							self.text = JSON.stringify(opt.peek(), null, 2)
						}
					}}
				/>
			)
		}
		case "string": {
			return (
				<entry
					valign={CENTER}
					tooltipText={"Enter text"}
					text={opt}
					onNotifyText={self => opt.set(self.get_text())}
				/>
			)
		}
		case "enum": return EnumSetter(opt, enums!)
		case "boolean": {
			return (
				<switch valign={CENTER} state={opt} active={opt} onNotifyState={self => opt.set(self.get_state())} />
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
							action: Gtk.FileChooserAction.OPEN,
							acceptLabel: "_Open",
							cancelLabel: "_Cancel"
						})
						chooser.add_filter(imageFilter)

						chooser.connect("response", (dialog, response) => {
							if (response === Gtk.ResponseType.ACCEPT) {
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
			const fontString = String(opt.peek())
			return (
				<Gtk.FontDialogButton
					valign={CENTER}
					tooltipText={"Select a font"}
					useSize={true}
					dialog={new Gtk.FontDialog}
					fontDesc={Pango.FontDescription.from_string(fontString)}
					onNotifyFontDesc={(self) => {
						const desc = self.get_font_desc()
						if (desc) {
							opt.set(desc.to_string())
						}
					}}
					$={(self) => {
						opt.subscribe(() => {
							self.set_font_desc(Pango.FontDescription.from_string(String(opt.peek())))
						})
					}}
				/>
			)
		}
		case "color": {
			return (
				<Gtk.ColorDialogButton
					valign={CENTER}
					tooltipText={"Select a color"}
					dialog={new Gtk.ColorDialog}
					onNotifyRgba={self => {
						opt.set(toHex(self.get_rgba()))
					}}
					rgba={opt.as(v => {
						const color = new Gdk.RGBA()
						color.parse(v as string)
						return color
					})}
				/>
			)
		}
		default:
			return <label
				label={`[ERROR]: No setter with type ${type}`}
			/>
	}
}

