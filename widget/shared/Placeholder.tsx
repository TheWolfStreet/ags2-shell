import { Gtk } from "ags/gtk4"
import { FCProps, Accessor } from "gnim"

const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

type PlaceholderProps = FCProps<Gtk.Box, {
	iconName?: Accessor<string> | string
	label?: Accessor<string> | string
	visible?: Accessor<boolean> | boolean
}>

export function Placeholder({ iconName, label, visible }: PlaceholderProps) {
	return (
		<box
			class="placeholder vertical"
			visible={visible}
			valign={CENTER}
			halign={CENTER}
			vexpand
			hexpand
			orientation={VERTICAL}
		>
			<image iconName={iconName} useFallback pixelSize={64} />
			<label label={label} />
		</box>
	)
}
