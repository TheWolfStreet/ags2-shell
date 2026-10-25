import { Gtk } from "ags/gtk4"
import { FCProps } from "ags"

import { type maybe_accessor } from "$lib/ui"
import { scaled } from "$shell/options"

const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

type placeholder_props = FCProps<
	Gtk.Box,
	{
		iconName?: maybe_accessor<string>
		iconSize?: maybe_accessor<number>
		label?: maybe_accessor<string>
		visible?: maybe_accessor<boolean>
	}
>

export function Placeholder({
	iconName: icon_name,
	iconSize: icon_size,
	label,
	visible,
}: placeholder_props) {
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
			<image
				iconName={icon_name}
				useFallback
				pixelSize={icon_size ?? scaled(64)}
			/>
			<label label={label} />
		</box>
	)
}
