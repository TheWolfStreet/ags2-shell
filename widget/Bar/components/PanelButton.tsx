import { Gtk } from "ags/gtk4"

import { onWindowToggle, Props, toggleClass } from "$lib/utils"

export function PanelButton({
	$,
	class: className,
	...props
}: Props<Gtk.Button, Gtk.Button.ConstructorProps>) {
	return (
		<button
			valign={Gtk.Align.CENTER}
			class={`panel-button ${className}`}
			canFocus={false}
			{...props}
			$={self => {
				if (self.name) {
					self.add_css_class(self.name)

					onWindowToggle(self.name, (w) => {
						toggleClass(self, "active", w.is_visible())
					})
				}

				$ && $(self)
			}}
		/>)
}
