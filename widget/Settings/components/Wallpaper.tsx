import { createBinding } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import Gio from "gi://Gio"

import { Placeholder } from "widget/shared/Placeholder"

import { fileExists, getFileSize, textureFromFile } from "$lib/utils"
import { wp } from "$lib/services"
import icons from "$lib/icons"

import options from "options"

const { COVER } = Gtk.ContentFit

export default function Wallpaper() {
	const wall = createBinding(wp, "wallpaper")

	let dialog: Gtk.FileDialog
	let dialogOpen = false

	async function openDialog() {
		if (dialogOpen) return
		dialogOpen = true

		if (!dialog) {
			dialog = new Gtk.FileDialog({
				title: "Set wallpaper",
				modal: true,
			})
		}

		if (fileExists(wp.get_wallpaper())) {
			const file = Gio.File.new_for_path(wp.get_wallpaper())
			dialog.set_initial_file(file)
		}

		dialog.open(null, null, (_, result) => {
			try {

				dialogOpen = false
				if (!result) return

				const file = dialog.open_finish(result)
				const filename = file ? file.get_path() : null
				if (filename) wp.set_wallpaper(filename)
			} catch (e: any) {
				if (e.code !== Gtk.DialogError.DISMISSED) throw e
			}
		})
	}

	return (
		<box class="row">
			<overlay>
				<Gtk.GestureClick
					onPressed={openDialog}
					$type="overlay"
				/>
				<revealer
					transitionDuration={options.transition.duration.as(v => v * 4)}
					revealChild={wall.as(v => !!v && (getFileSize(v) ?? 0) == 0)}
					transitionType={Gtk.RevealerTransitionType.CROSSFADE}
					$type="overlay"
				>
					<Placeholder
						iconName={icons.missing}
						label={"No wallpaper set"}
					/>
				</revealer>
				<Gtk.Picture
					tooltipText={"Set wallpaper"}
					class="preview"
					hexpand
					vexpand
					contentFit={COVER}
					paintable={wall.as(v => textureFromFile(v) as Gdk.Paintable)}
				>
				</Gtk.Picture>
			</overlay>
		</box>
	)
}
