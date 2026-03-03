import Gio from "gi://Gio"
import GLib from "gi://GLib"

export function fileExists(path: string) {
	return GLib.file_test(path, GLib.FileTest.EXISTS)
}

export function ensurePath(path: string) {
	if (fileExists(path))
		return

	const file = Gio.File.new_for_path(path)
	if (path.endsWith("/")) {
		file.make_directory_with_parents(null)
		return
	}

	const parent = file.get_parent()
	if (parent) {
		const parentPath = parent.get_path()
		if (parentPath && !fileExists(parentPath))
			parent.make_directory_with_parents(null)
	}
	file.create(Gio.FileCreateFlags.PRIVATE, null)
}
