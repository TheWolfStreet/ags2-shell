import { bind } from "astal"
import { Widget, Gtk, Gdk } from "astal/gtk3"

import { type RowProps } from "./Row"
import { ColorButton, FileChooserButton, FontButton, SpinButton } from "../../GtkWidgets"

import { Opt } from "../../../lib/option"
import icons from "../../../lib/icons"
import { initHook } from "../../../lib/utils"

const rgba = new Gdk.RGBA
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
	const lbl = new Widget.Label({
		label: opt()
	})
	opt.bind(lbl.label)

	const step = (dir: 1 | -1) => {
		const i = values.findIndex(i => i === lbl.label)
		opt.set(dir > 0
			? i + dir > values.length - 1 ? values[0] : values[i + dir]
			: i + dir < 0 ? values[values.length - 1] : values[i + dir],
		)
	}
	return (
		<box className="enum-setter">
			{lbl}
			<button onClicked={() => step(-1)}>
				<box>
					<icon icon={icons.ui.arrow.left} />
				</box>
			</button>
			<button onClicked={() => step(+1)}>
				<box>
					<icon icon={icons.ui.arrow.right} />
				</box>
			</button>
		</box>
	)
}

export default function Setter<T>({
	opt,
	type = (typeof opt.get() as unknown) as RowProps<T>["type"],
	enums,
	max = 1000,
	min = 0,
}: RowProps<T>) {
	switch (type) {
		case "number": {
			return (
				<SpinButton
					adjustment={new Gtk.Adjustment({ lower: min, upper: max, stepIncrement: 1, pageIncrement: 5 })}
					numeric
					value={opt(v => v as number)}
					setup={self => {
						self.hook(self, "value-changed", () => {
							opt.set(self.value as T)
						})
						self.value = opt.get() as number
					}}
				>
				</SpinButton>
			)
		}
		case "float":
		case "object": {
			return (
				<entry
					text={opt(t => JSON.stringify(t, null, 2))}
					onChanged={self => {
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
				<entry tooltipText={"Enter text"}
					text={opt(v => v as string)}
					onChanged={self => opt.set(self.get_text() as T)}
				/>
			)
		}
		case "enum": return EnumSetter(opt as Opt<string>, enums!)
		case "boolean": {
			return (
				<switch
					state={opt(v => v as boolean)}
					setup={self => {
						self.hook(bind(self, "state"), () => opt.set(self.state as T))
					}}>
				</switch>
			)
		}
		case "img": {
			return (
				<FileChooserButton
					tooltipText={"Select an image"}
					onFileSet={self => opt.set(self.get_filename() as T)}
					filter={filter}
					setup={self => {
						initHook(self, opt, () => {
							self.set_filename(opt.get() as string)
						})
					}}
				/>
			)
		}
		case "font": {
			return (
				<FontButton
					tooltipText={"Select a font"}
					font={opt(f => f as string)}
					showSize={false}
					useSize={false}
					onFontSet={self => {
						opt.set(cleanFont(self.font) as T)
					}}
					setup={
						self => {
							initHook(self, opt, () => {
								self.font = opt.get() as string
							})
						}} />
			)
		}
		case "color": {
			return (
				<ColorButton
					tooltipText={"Select a color"}
					onColorSet={self => {
						opt.set(toHex(self.get_rgba()) as T)
					}}
					setup={
						self => {
							initHook(self, opt, () => {
								if (rgba.parse(opt.get() as string)) {
									self.set_rgba(rgba)
								}
							})
						}} />
			)
		}
		default: return <label
			label={`[ERROR]: No setter with type ${type}`}
		></label>
	}
}
