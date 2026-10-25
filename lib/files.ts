import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { attempt, err, ok, type result } from "$lib/result"

export const max_image_bytes = 64 * 1024 * 1024
const max_image_dimension = 8192
const max_image_pixels = 40_000_000

export function file_size(path: string): result<number> {
	return attempt(() =>
		Gio.File.new_for_path(path)
			.query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null)
			.get_size(),
	)
}

export function file_exists(path: string) {
	return GLib.file_test(path, GLib.FileTest.EXISTS)
}

function is_io_error(error: unknown, code: number): boolean {
	return (
		error instanceof GLib.Error && error.matches(Gio.io_error_quark(), code)
	)
}

export function is_exists_error(error: unknown): boolean {
	return is_io_error(error, Gio.IOErrorEnum.EXISTS)
}

export function is_not_found_error(error: unknown): boolean {
	return is_io_error(error, Gio.IOErrorEnum.NOT_FOUND)
}

function check_file_type(
	file: Gio.File,
	expected: Gio.FileType,
	failure: string,
): result<void> {
	const kind = attempt(() =>
		file
			.query_info("standard::type", Gio.FileQueryInfoFlags.NONE, null)
			.get_file_type(),
	)
	if (!kind.ok) return kind
	if (kind.value === expected) return ok(undefined)
	return err(new Error(failure))
}

export function ensure_directory(path: string): result<void> {
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

export function ensure_file(path: string): result<void> {
	const file = Gio.File.new_for_path(path)
	const parent = file.get_parent()?.get_path()
	if (parent) {
		const ready = ensure_directory(parent)
		if (!ready.ok) return ready
	}
	const created = attempt(() => file.create(Gio.FileCreateFlags.PRIVATE, null))
	if (!created.ok && is_exists_error(created.err))
		return check_file_type(
			file,
			Gio.FileType.REGULAR,
			`Not a regular file: ${path}`,
		)
	if (!created.ok) return created
	const closed = attempt(() => created.value.close(null))
	if (!closed.ok) return closed
	if (!closed.value)
		return err(new Error(`Could not close created file: ${path}`))
	return ok(undefined)
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

type file_signature = { value: string; size: number }

function signature_of(info: Gio.FileInfo): file_signature {
	const size = info.get_size()
	const value = [
		size,
		info.get_attribute_uint64("time::modified"),
		info.get_attribute_uint32("time::modified-usec"),
		info.get_attribute_string("etag::value") ?? "",
	].join(":")
	return { value, size }
}

export function query_file_signature(
	path: string,
): result<file_signature | null> {
	const info = attempt(() =>
		Gio.File.new_for_path(path).query_info(
			"standard::size,time::modified,time::modified-usec,etag::value",
			Gio.FileQueryInfoFlags.NONE,
			null,
		),
	)
	if (info.ok) return ok(signature_of(info.value))
	if (is_not_found_error(info.err)) return ok(null)
	return info
}
