import { Accessor } from "ags"
import { Gtk } from "ags/gtk4"

export function Placeholder({ iconName, label, visible }: { iconName?: string | Accessor<string>, label?: string | Accessor<string>, visible?: boolean | Accessor<boolean> }) {
	return (
		<box class="placeholder vertical" visible={visible} valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER} vexpand hexpand orientation={Gtk.Orientation.VERTICAL}>
			<image iconName={iconName} useFallback pixelSize={64} />
			<label label={label} />
		</box>
	)
}

