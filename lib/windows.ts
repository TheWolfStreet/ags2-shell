// Shows or hides windows, disables their input areas, and removes monitor windows safely.

import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { idle } from "ags/time"

import giCairo from "cairo"

export function toggleWindow(name: string | undefined, hide: boolean = true) {
	if (name == undefined) return
	const win = app.get_window(name)
	if (win?.visible) {
		if (hide)
			win.hide()
		else
			win.close()
	} else {
		win?.show()
	}
}

export function ignoreInput(widget: Gtk.Window) {
	widget.get_surface()?.set_input_region(new giCairo.Region)
}

export function onWindowToggle(name: string, callback: (w: Gtk.Window) => void) {
	const handler = app.connect("window-toggled", (_, w: Gtk.Window) => {
		if (w.name === name)
			callback(w)
	})

	return () => app.disconnect(handler)
}

// GTK 4.22 crashes when destroying an unmapped application window. Hide it instead;
// windows with a surface must still be destroyed so they cannot be re-anchored.
export function releaseMonitorWindow(win?: Gtk.Window | null) {
	if (!win) return
	idle(() => {
		if (win.get_application() && !win.get_surface())
			win.set_visible(false)
		else
			win.destroy()
	})
}
