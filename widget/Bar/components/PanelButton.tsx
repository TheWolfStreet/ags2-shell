// Updates a bar button when its popup opens or closes.

import { onCleanup } from "ags"
import { Gtk } from "ags/gtk4"

import { Props, toggleClass } from "$lib/ui"
import { onWindowToggle } from "$lib/windows"

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
			class={`${name ?? ""} ${className ?? ""}`}
			canFocus={false}
			{...props}
			$={self => {
				if (self.name) {
					onCleanup(onWindowToggle(self.name, (w) => {
						toggleClass(self, "active", w.is_visible())
					}))
				}

				$ && $(self)
			}}
		/>
	)
}
