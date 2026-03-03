import { createBinding } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import Gio from "gi://Gio"

import { Placeholder } from "widget/shared/Placeholder"

import { fileExists } from "$lib/files"
import { attempt } from "$lib/result"
import { getFileSize, textureFromFile } from "$lib/textures"
import { wp } from "$lib/services"
import icons from "$lib/icons"

import options from "options"

const { COVER } = Gtk.ContentFit
const { CROSSFADE } = Gtk.RevealerTransitionType
const { DISMISSED } = Gtk.DialogError

export default function Wallpaper() {
	const wall = createBinding(wp, "wallpaper")

	let dialog: Gtk.FileDialog
	let dialogOpen: boolean = false

	async function openDialog() {
		if (dialogOpen) return
		dialogOpen = true

		if (!dialog) {
			dialog = new Gtk.FileDialog({
				title: "Set wallpaper",
				modal: true,
			})
		}

		if (fileExists(wp.wallpaper)) {
			const file = Gio.File.new_for_path(wp.wallpaper)
			dialog.set_initial_file(file)
		}

		dialog.open(null, null, (_, result) => {
			const outcome = attempt(() => {
				dialogOpen = false
				if (!result) return

				const file = dialog.open_finish(result)
				const filename = file ? file.get_path() : null
				if (filename) wp.setWallpaper(filename)
			})
			if (!outcome.ok) {
				const e = outcome.err
				if (e && typeof e === "object" && "code" in e && e.code !== DISMISSED) throw e
			}
		})
	}

	const isSet = wall.as(v => !!v && (getFileSize(v) ?? 0) > 0)

	return (
		<box class="row">
			<overlay
				cursor={Gdk.Cursor.new_from_name("pointer", null)}
				tooltipText={isSet.as(set => set ? "Middle-click to clear" : null)}
			>
				<Gtk.GestureClick
					button={Gdk.BUTTON_PRIMARY}
					onPressed={openDialog}
				/>
				<Gtk.GestureClick
					button={Gdk.BUTTON_MIDDLE}
					onPressed={() => void wp.clearWallpaper()}
				/>
				<revealer
					transitionDuration={options.transition.duration.as(v => v * 4)}
					revealChild={wall.as(v => !!v && (getFileSize(v) ?? 0) == 0)}
					transitionType={CROSSFADE}
					$type="overlay"
				>
					<Placeholder
						iconName={icons.missing}
						label={"Click here to set wallpaper"}
					/>
				</revealer>
				<Gtk.Picture
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
