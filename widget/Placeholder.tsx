// Shows an optional icon and message when a list has no content.

import { Gtk } from "ags/gtk4"
import { FCProps, Accessor } from "ags"

import options from "options"

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
			<image iconName={iconName} useFallback pixelSize={options.scale.as(scale => Math.round(64 * scale / 100))} />
			<label label={label} />
		</box>
	)
}
