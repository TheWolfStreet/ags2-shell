// Updates a bar button when its popup opens or closes.

import { onCleanup } from "ags"
import { Gtk } from "ags/gtk4"

import { Props, toggleClass } from "$lib/ui"
import { onWindowToggle, toggleWindow } from "$lib/windowing"

const { CENTER } = Gtk.Align

type PanelButtonProps = Props<Gtk.Button, Gtk.Button.ConstructorProps> & {
	targetWindow?: string
}

export function PanelButton({
	$,
	targetWindow,
	name = targetWindow,
	class: className,
	onClicked = () => toggleWindow(targetWindow),
	...props
}: PanelButtonProps) {
	return (
		<button
			name={name}
			valign={CENTER}
			class={`${name ?? ""} ${className ?? ""}`}
			canFocus={false}
			onClicked={onClicked}
			{...props}
			$={self => {
				if (targetWindow) {
					onCleanup(onWindowToggle(targetWindow, (w) => {
						toggleClass(self, "active", w.is_visible())
					}))
				}

				$ && $(self)
			}}
		/>
	)
}
