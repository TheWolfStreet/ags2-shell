import { Gdk, Gtk } from "ags/gtk4"

import { RowProps } from "./Row"

import icons from "$lib/icons"
import { Opt } from "$lib/option"

const { CENTER } = Gtk.Align

const filter = new Gtk.FileFilter()
filter.add_mime_type('image/*')

function cleanFont(font: string) {
	return font.split(" ").slice(0, -1).join(" ")
}

function toHex(rgba: Gdk.RGBA) {
	const { red, green, blue } = rgba
	return `#${[red, green, blue]
		.map((n) => Math.floor(255 * n).toString(16).padStart(2, '0'))
		.join('')}`
}

function EnumSetter(opt: Opt<string>, values: string[]) {
	const step = (dir: 1 | -1) => {
		const i = values.findIndex(i => i === opt.get())
		opt.set(dir > 0
			? i + dir > values.length - 1 ? values[0] : values[i + dir]
			: i + dir < 0 ? values[values.length - 1] : values[i + dir],
		)
	}
	return (
		<box class="enum-setter">
			<label label={opt}></label>
			<button onClicked={() => step(-1)}>
				<box>
					<image iconName={icons.ui.arrow.left} />
				</box>
			</button>
			<button onClicked={() => step(+1)}>
				<box>
					<image iconName={icons.ui.arrow.right} />
				</box>
			</button>
		</box>
	)
}

export default function Setter({
	opt,
	type = (typeof opt.get() as unknown) as RowProps["type"],
	enums,
	max = 1000,
	min = 0,
}: RowProps) {
	switch (type) {
		case "number": {
			return (
				<Gtk.SpinButton
					valign={CENTER}
					adjustment={new Gtk.Adjustment({ lower: min, upper: max, stepIncrement: 1, pageIncrement: 5 })}
					numeric
					value={opt.as(v => v as number)}
					onNotifyValue={(self) => opt.set(self.value)}
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
							self.text = JSON.stringify(opt.get(), null, 2)
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
					text={opt.as(v => v as string)}
					onNotifyText={self => opt.set(self.get_text())}
				/>
			)
		}
		case "enum": return EnumSetter(opt, enums!)
		case "boolean": {
			return (
				<switch valign={CENTER} state={opt} onNotifyState={self => opt.set(self.get_state())} />
			)
		}
		case "img": {
			return (
				<Gtk.Button
					valign={CENTER}
					label="Select an image"
					tooltipText="Select an image"
					onClicked={_ => {
						const chooser = new Gtk.FileChooserNative({
							title: "Select an image",
							action: Gtk.FileChooserAction.OPEN,
							acceptLabel: "_Open",
							cancelLabel: "_Cancel"
						})

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
			return (
				<Gtk.FontButton
					valign={CENTER}
					tooltipText={"Select a font"}
					font={opt.as(f => f as string)}
					useSize={false}
					onFontSet={self => {
						opt.set(cleanFont(self.font))
					}} />
			)
		}
		case "color": {
			return (
				<Gtk.ColorButton
					valign={CENTER}
					tooltipText={"Select a color"}
					onColorSet={self => {
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

