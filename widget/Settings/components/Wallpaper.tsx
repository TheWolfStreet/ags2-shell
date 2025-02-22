import { bind } from "astal"
import { Gtk } from "astal/gtk3"

import { FileChooserButton } from "../../GtkWidgets"
import { Row } from "./Row"

import { wp } from "../../../lib/services"
import { initHook } from "../../../lib/utils"

const filter = new Gtk.FileFilter()
filter.add_mime_type('image/*')

export default () => {
	const wall = bind(wp, "wallpaper")
	return (
		<box className="row wallpaper" vertical>
			<box className="preview"
				css={wall.as(wp => `
			min-height: 200px;
			min-width: 200px;
			background-image: url('${wp}');
			background-size: cover;`)}
				hexpand vexpand>
				<FileChooserButton
					filter={filter}
					vexpand hexpand
					tooltipText={"Set wallpaper"}
					opacity={0}
					onFileSet={self => {
						const filename = self.get_filename()
						if (filename) {
							wp.wallpaper = filename
						}
					}}
					setup={self => {
						initHook(self, wall, () => {
							self.set_filename(wp.wallpaper)
						})
					}}
				/>
			</box>
		</box> as Row)
}
