import { createRoot, createState } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import app from "$lib/app"
import icons from "$lib/icons"
import { idle } from "$lib/time"
import { IconPicker } from "./IconPicker"

export function choose_icon(
	anchor: Gtk.Widget,
	on_pick: (name: string) => void,
) {
	const parent = anchor.get_root()
	createRoot((dispose) => {
		const [active, set_active] = createState(false)

		function close() {
			window.close()
		}

		function pick(name: string) {
			on_pick(name)
			close()
		}

		function close_on_escape(_controller: unknown, keyval: number) {
			if (keyval !== Gdk.KEY_Escape) return false
			close()
			return true
		}

		const window = (
			<Gtk.Window
				title="Pick an Icon"
				class="dialog icon-chooser"
				application={app}
				transientFor={parent instanceof Gtk.Window ? parent : undefined}
				modal
				defaultWidth={484}
				defaultHeight={310}
				iconName={icons.ui.search}
				onCloseRequest={() => {
					set_active(false)
					idle(dispose)
					return false
				}}
			>
				<Gtk.EventControllerKey onKeyPressed={close_on_escape} />
				<Gtk.HeaderBar $type="titlebar" showTitleButtons={false}>
					<button $type="start" label="Cancel" onClicked={close} />
				</Gtk.HeaderBar>
				<IconPicker active={active} on_pick={pick} />
			</Gtk.Window>
		) as Gtk.Window

		window.present()
		set_active(true)
	})
}
