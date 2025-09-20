import { Gtk } from "ags/gtk4"

import { onWindowToggle, Props, toggleClass } from "$lib/utils"

const { CENTER } = Gtk.Align

export function PanelButton({
	$,
	name,
	class: className,
	...props
}: Props<Gtk.Button, Gtk.Button.ConstructorProps>) {
	return (
		<button
			name={name}
			valign={CENTER}
			class={`panel-button ${name ?? ""} ${className}`}
			canFocus={false}
			{...props}
			$={self => {
				if (self.name) {
					onWindowToggle(self.name, (w) => {
						toggleClass(self, "active", w.is_visible())
					})
				}

				$ && $(self)
			}}
		/>
	)
}
