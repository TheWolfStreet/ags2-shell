import { createBinding } from "ags"
import { Gtk } from "ags/gtk4"

import Gdk from "gi://Gdk"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"

import { wp } from "$lib/services"

export default function Wallpaper() {
	const wall = createBinding(wp, "wallpaper")
	let dialog: Gtk.FileDialog
	let dialogOpen = false

	function openDialog() {
		if (dialogOpen) return
		dialogOpen = true

		if (!dialog) {
			dialog = new Gtk.FileDialog({
				title: "Set wallpaper",
				modal: true,
			})
		}

		if (wp.wallpaper) {
			const file = Gio.File.new_for_path(wp.wallpaper)
			dialog.set_initial_file(file)
		}

		dialog.open(null, null, (_, result) => {
			dialogOpen = false
			if (!result) return

			const file = dialog.open_finish(result)
			const filename = file ? file.get_path() : null
			if (filename) wp.wallpaper = filename
		})
	}

	return (
		<box class="row">
			<Gtk.Picture
				tooltipText={"Set wallpaper"}
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
					onPressed={openDialog}
				/>
			</Gtk.Picture>
		</box>
	)
}
