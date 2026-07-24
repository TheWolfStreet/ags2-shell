// Checks paths and creates missing files and parent folders.

import Gio from "gi://Gio"
import GLib from "gi://GLib"

export function fileExists(path: string) {
	return GLib.file_test(path, GLib.FileTest.EXISTS)
}

export function ensureDirectory(path: string) {
	if (!fileExists(path))
		Gio.File.new_for_path(path).make_directory_with_parents(null)
}

export function ensureFile(path: string) {
	if (fileExists(path)) return

	const file = Gio.File.new_for_path(path)
	const parent = file.get_parent()
	if (parent) {
		const parentPath = parent.get_path()
		if (parentPath) ensureDirectory(parentPath)
	}
	file.create(Gio.FileCreateFlags.PRIVATE, null)
}
