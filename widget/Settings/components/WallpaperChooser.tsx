// Shows the current wallpaper and lets users choose another image file.

import { createBinding } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import Gio from "gi://Gio"

import { Placeholder } from "widget/Placeholder"

import { fileExists } from "$lib/files"
import { attempt } from "$lib/result"
import { getFileSize, textureFromFile } from "$lib/textures"
import { wallpaperService } from "widget/Wallpaper"
import icons from "$lib/icons"

import options from "options"

const { COVER } = Gtk.ContentFit
const { CROSSFADE } = Gtk.RevealerTransitionType
const { DISMISSED } = Gtk.DialogError

export default function WallpaperChooser() {
	const wall = createBinding(wallpaperService, "wallpaper")

	let dialog: Gtk.FileDialog
	let dialogOpen: boolean = false

	function openDialog() {
		if (dialogOpen) return
		dialogOpen = true

		const opened = attempt(() => {
			if (!dialog) {
				dialog = new Gtk.FileDialog({
					title: "Set wallpaper",
					modal: true,
				})
			}

			if (fileExists(wallpaperService.wallpaper))
				dialog.set_initial_file(Gio.File.new_for_path(wallpaperService.wallpaper))

			dialog.open(null, null, (_, result) => {
				dialogOpen = false
				if (!result) return

				const outcome = attempt(() => dialog.open_finish(result)?.get_path() ?? null)
				if (outcome.ok) {
					if (outcome.value) void wallpaperService.setWallpaper(outcome.value)
					return
				}

				const error = outcome.err
				const dismissed = error !== null
					&& typeof error === "object"
					&& "code" in error
					&& error.code === DISMISSED
				if (!dismissed)
					console.error("wallpaper.dialog: Failed to choose wallpaper", error)
			})
		})

		if (!opened.ok) {
			dialogOpen = false
			console.error("wallpaper.dialog: Failed to open wallpaper chooser", opened.err)
		}
	}

	const isSet = wall.as(v => !!v && (getFileSize(v) ?? 0) > 0)

	return (
		<box class="row">
			<overlay
				cursor={Gdk.Cursor.new_from_name("pointer", null)}
				tooltipText={isSet.as(set => set ? "Middle-click to clear" : "")}
			>
				<Gtk.GestureClick
					button={Gdk.BUTTON_PRIMARY}
					onPressed={openDialog}
				/>
				<Gtk.GestureClick
					button={Gdk.BUTTON_MIDDLE}
					onPressed={() => void wallpaperService.clearWallpaper()}
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
					canShrink
					contentFit={COVER}
					paintable={wall.as(v => textureFromFile(v) as Gdk.Paintable)}
				/>
			</overlay>
		</box>
	)
}
