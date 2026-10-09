import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { attempt, err, ok, type Result } from "$lib/result"

export function file_exists(path: string) {
	return GLib.file_test(path, GLib.FileTest.EXISTS)
}

export function ensure_directory(path: string): Result<void> {
	const file = Gio.File.new_for_path(path)
	const created = attempt(() => file.make_directory_with_parents(null))
	if (created.ok) return ok(undefined)
	if (
		created.err instanceof GLib.Error &&
		created.err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.EXISTS)
	) {
		const kind = attempt(() =>
			file
				.query_info("standard::type", Gio.FileQueryInfoFlags.NONE, null)
				.get_file_type(),
		)
		if (!kind.ok) return kind
		if (kind.value === Gio.FileType.DIRECTORY) return ok(undefined)
		return err(new Error(`Not a directory: ${path}`))
	}
	return created
}

export function ensure_file(path: string): Result<void> {
	const file = Gio.File.new_for_path(path)
	const parent = file.get_parent()?.get_path()
	if (parent) {
		const ready = ensure_directory(parent)
		if (!ready.ok) return ready
	}
	const created = attempt(() => file.create(Gio.FileCreateFlags.PRIVATE, null))
	if (!created.ok) {
		if (
			created.err instanceof GLib.Error &&
			created.err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.EXISTS)
		) {
			const kind = attempt(() =>
				file
					.query_info("standard::type", Gio.FileQueryInfoFlags.NONE, null)
					.get_file_type(),
			)
			if (!kind.ok) return kind
			if (kind.value === Gio.FileType.REGULAR) return ok(undefined)
			return err(new Error(`Not a regular file: ${path}`))
		}
		return created
	}
	const closed = attempt(() => created.value.close(null))
	if (!closed.ok) return closed
	return closed.value
		? ok(undefined)
		: err(new Error(`Could not close created file: ${path}`))
}
