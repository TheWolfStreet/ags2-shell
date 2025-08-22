import { Gtk } from "ags/gtk4"
import { onWindowToggle, Props } from "$lib/utils"

export default ({
	$,
	...props
}: Props<Gtk.Button, Gtk.Button.ConstructorProps>) =>
	<button
		class="panel-button"
		{...props}
		$={self => {
			if (self.name)
				self.add_css_class(self.name)

			let is_active = false

			if (self.name)
				onWindowToggle(self.name, () => {
					is_active = !is_active

					if (is_active)
						self.add_css_class("active")
					else
						self.remove_css_class("active")
				})

			if ($)
				$(self)
		}}
	/>
