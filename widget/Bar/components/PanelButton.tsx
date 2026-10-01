import { createComputed, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import app from "$lib/app"

import { is_accessor, Props, toggle_class } from "$lib/ui"
import { on_window_toggle, toggle_window } from "$lib/windowing"

const { CENTER } = Gtk.Align

type panel_button_props = Props<Gtk.Button, Gtk.Button.ConstructorProps> & {
	targetWindow?: string
}

export function PanelButton({
	$,
	targetWindow: target_window,
	name = target_window,
	class: class_name,
	onClicked: on_clicked = () => toggle_window(target_window),
	...props
}: panel_button_props) {
	const classes = createComputed(() => {
		const button_name = is_accessor<string>(name) ? name() : name
		const extra_class = is_accessor<string>(class_name) ? class_name() : class_name
		return `${button_name ?? ""} ${extra_class ?? ""}`
	})
	return (
		<button
			name={name}
			valign={CENTER}
			class={classes}
			canFocus={false}
			onClicked={on_clicked}
			{...props}
			$={self => {
				if (target_window) {
					const initial = app.get_window(target_window)
					if (initial) toggle_class(self, "active", initial.is_visible())
					onCleanup(on_window_toggle(target_window, (window) => {
						toggle_class(self, "active", window.is_visible())
					}))
				}

				$ && $(self)
			}}
		/>
	)
}
