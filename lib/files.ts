import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { attempt, err, ok, type Result } from "$lib/result"

export const max_image_bytes = 64 * 1024 * 1024
const max_image_dimension = 8192
const max_image_pixels = 40_000_000

export function file_exists(path: string) {
	return GLib.file_test(path, GLib.FileTest.EXISTS)
}

export function is_exists_error(error: unknown): boolean {
	return (
		error instanceof GLib.Error &&
		error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.EXISTS)
	)
}

function check_file_type(
	file: Gio.File,
	expected: Gio.FileType,
	failure: string,
): Result<void> {
	const kind = attempt(() =>
		file
			.query_info("standard::type", Gio.FileQueryInfoFlags.NONE, null)
			.get_file_type(),
	)
	if (!kind.ok) return kind
	if (kind.value === expected) return ok(undefined)
	return err(new Error(failure))
}

export function ensure_directory(path: string): Result<void> {
	const file = Gio.File.new_for_path(path)
	const created = attempt(() => file.make_directory_with_parents(null))
	if (created.ok) return ok(undefined)
	if (is_exists_error(created.err))
		return check_file_type(
			file,
			Gio.FileType.DIRECTORY,
			`Not a directory: ${path}`,
		)
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
		if (is_exists_error(created.err))
			return check_file_type(
				file,
				Gio.FileType.REGULAR,
				`Not a regular file: ${path}`,
			)
		return created
	}
	const closed = attempt(() => created.value.close(null))
	if (!closed.ok) return closed
	return closed.value
		? ok(undefined)
		: err(new Error(`Could not close created file: ${path}`))
}

export function valid_image_dimensions(width: number, height: number) {
	return (
		width > 0 &&
		height > 0 &&
		width <= max_image_dimension &&
		height <= max_image_dimension &&
		width * height <= max_image_pixels
	)
}

export function query_file_signature(
	path: string,
): Result<{ value: string; size: number } | null> {
	const result = attempt(() =>
		Gio.File.new_for_path(path).query_info(
			"standard::size,time::modified,time::modified-usec,etag::value",
			Gio.FileQueryInfoFlags.NONE,
			null,
		),
	)
	if (result.ok) {
		const size = result.value.get_size()
		const value = [
			size,
			result.value.get_attribute_uint64("time::modified"),
			result.value.get_attribute_uint32("time::modified-usec"),
			result.value.get_attribute_string("etag::value") ?? "",
		].join(":")
		return ok({ value, size })
	}
	if (
		result.err instanceof GLib.Error &&
		result.err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)
	)
		return ok(null)
	return result
}
