import { Gtk } from "ags/gtk4"
import { idle } from "ags/time"

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
