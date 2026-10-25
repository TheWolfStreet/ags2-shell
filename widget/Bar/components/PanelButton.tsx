import { onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import app from "$lib/app"

import { props, toggle_class } from "$lib/ui"
import { on_window_toggle, toggle_window } from "$lib/windowing"

const { CENTER } = Gtk.Align

type panel_button_props = Omit<
	props<Gtk.Button, Gtk.Button.ConstructorProps>,
	"name" | "class"
> & {
	name?: string
	class?: string
	target_window?: string
}

function track_window_state(button: Gtk.Button, window_name: string) {
	const window = app.get_window(window_name)
	if (window) toggle_class(button, "active", window.is_visible())
	onCleanup(
		on_window_toggle(window_name, (toggled) =>
			toggle_class(button, "active", toggled.is_visible()),
		),
	)
}

export function PanelButton({
	$,
	target_window,
	name = target_window,
	class: class_name,
	onClicked: on_clicked = () => toggle_window(target_window),
	...props
}: panel_button_props) {
	return (
		<button
			name={name}
			valign={CENTER}
			class={`${name ?? ""} ${class_name ?? ""}`}
			canFocus={false}
			onClicked={on_clicked}
			{...props}
			$={(self) => {
				if (target_window) track_window_state(self, target_window)
				$?.(self)
			}}
		/>
	)
}
