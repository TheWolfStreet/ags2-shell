import { Accessor } from "ags"
import { Gtk } from "ags/gtk4"

const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

export function Placeholder({ iconName, label, visible }: { iconName?: string | Accessor<string>, label?: string | Accessor<string>, visible?: boolean | Accessor<boolean> }) {
	return (
		<box class="placeholder vertical" visible={visible} valign={CENTER} halign={CENTER} vexpand hexpand orientation={VERTICAL}>
			<image iconName={iconName} useFallback pixelSize={64} />
			<label label={label} />
		</box>
	)
}

