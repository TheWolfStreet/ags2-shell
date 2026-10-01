import { Gtk } from "ags/gtk4"
import { FCProps, Accessor } from "ags"

import options from "$shell/options"

const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

type placeholder_props = FCProps<Gtk.Box, {
	iconName?: Accessor<string> | string
	iconSize?: Accessor<number> | number
	label?: Accessor<string> | string
	visible?: Accessor<boolean> | boolean
}>

export function Placeholder({ iconName: icon_name, iconSize: icon_size, label, visible }: placeholder_props) {
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
			<image iconName={icon_name} useFallback pixelSize={icon_size ?? options.scale.as(scale => Math.round(64 * scale / 100))} />
			<label label={label} />
		</box>
	)
}
