import { createBinding } from "ags"
import { Gtk } from "ags/gtk4"

import Gdk from "gi://Gdk"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"

import { wp } from "$lib/services"

export default function Wallpaper() {
	const wall = createBinding(wp, "wallpaper")
	let chooser: Gtk.FileChooserNative
	function open_wallpaper_chooser() {
		if (!chooser) {

			chooser = new Gtk.FileChooserNative({
				title: "Set wallpaper",
				action: Gtk.FileChooserAction.OPEN,
				acceptLabel: "_Open",
				cancelLabel: "_Cancel"
			})

			if (wp.wallpaper) {
				const file = Gio.File.new_for_path(wp.wallpaper)
				chooser.set_file(file)
			}

			chooser.connect("response", (dialog, response) => {
				if (response === Gtk.ResponseType.ACCEPT) {
					const file = chooser.get_file()
					const filename = file ? file.get_path() : null
					if (filename) wp.wallpaper = filename
				}
				dialog.destroy()
			})

			chooser.show()
		}
	}

	return (
		<box class="row">
			<Gtk.Picture
				class="preview"
				hexpand
				vexpand
				contentFit={Gtk.ContentFit.COVER}
				paintable={
					wall.as(path => {
						return Gdk.Texture.new_for_pixbuf(
							GdkPixbuf.Pixbuf.new_from_file(path)
						)
					})
				}
			>
				<Gtk.GestureClick
					onPressed={open_wallpaper_chooser}
				/>
			</Gtk.Picture>
		</box>
	)
}
