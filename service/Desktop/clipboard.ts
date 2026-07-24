// Converts copied file paths between GTK and Wayland clipboard formats.

import { Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"

import Gio from "gi://Gio"

import { attemptAsync } from "$lib/result"

export type ClipboardPayload = {
	operation: "copy" | "cut"
	files: string[]
}

type ClipboardOperation = ClipboardPayload["operation"]

function stringToBytes(value: string) {
	return new TextEncoder().encode(value)
}

export function serializeFileClipboard(paths: string[], operation: ClipboardOperation) {
	const files = paths.map(path => Gio.File.new_for_path(path))
	const uris = files.map(file => file.get_uri())
	return {
		files,
		uriList: `${uris.join("\r\n")}\r\n`,
		gnomePayload: `${operation}\n${uris.join("\n")}`,
	}
}

export function buildFileContentProvider(paths: string[], operation: ClipboardOperation) {
	const payload = serializeFileClipboard(paths, operation)
	return Gdk.ContentProvider.new_union([
		Gdk.ContentProvider.new_for_value(Gdk.FileList.new_from_array(payload.files)),
		Gdk.ContentProvider.new_for_bytes("text/uri-list", stringToBytes(payload.uriList)),
		Gdk.ContentProvider.new_for_bytes("x-special/gnome-copied-files", stringToBytes(payload.gnomePayload)),
	])
}

export async function setClipboardFiles(operation: ClipboardOperation, paths: string[]): Promise<void | Error> {
	if (paths.length === 0)
		return

	const display = Gdk.Display.get_default()
	if (display) {
		display.get_clipboard().set_content(buildFileContentProvider(paths, operation))
		return
	}

	const payload = serializeFileClipboard(paths, operation)
	const primary = await attemptAsync(async () => execAsync(["wl-copy", "-t", "x-special/gnome-copied-files", payload.gnomePayload]))
	if (primary.ok)
		return

	const fallback = await attemptAsync(async () => execAsync(["wl-copy", "-t", "text/uri-list", payload.uriList]))
	if (fallback.ok)
		return

	return new Error("Failed to write desktop clipboard payload", {
		cause: { primaryError: primary.err, fallbackError: fallback.err },
	})
}

export async function clearClipboardFiles(): Promise<void | Error> {
	const display = Gdk.Display.get_default()
	if (display) {
		const cleared = display.get_clipboard().set_content(null)
		if (!cleared)
			return new Error("Failed to clear desktop clipboard payload")
		return
	}

	return execAsync(["wl-copy", "--clear"])
		.then(() => undefined)
		.catch(error => new Error("Failed to clear desktop clipboard payload", { cause: error }))
}

async function readClipboardMime(mimeType: string) {
	return execAsync(["wl-paste", "-t", mimeType]).catch(() => null)
}

function pathsFromUris(uris: string[]) {
	return uris
		.map(uri => Gio.File.new_for_uri(uri).get_path())
		.filter((path): path is string => !!path)
}

export async function getClipboardFiles(): Promise<ClipboardPayload | null> {
	const copiedFiles = await readClipboardMime("x-special/gnome-copied-files")
	if (copiedFiles) {
		const lines = copiedFiles.split("\n").map(line => line.trim()).filter(Boolean)
		const files = pathsFromUris(lines.slice(1))
		if (files.length > 0) {
			let operation: ClipboardOperation = "copy"
			if (lines[0] === "cut")
				operation = "cut"
			return { operation, files }
		}
	}

	const uriList = await readClipboardMime("text/uri-list")
	if (!uriList)
		return null

	const files = pathsFromUris(uriList
		.split("\n")
		.map(line => line.trim())
		.filter(line => line && !line.startsWith("#")),
	)
	if (files.length === 0)
		return null
	return { operation: "copy", files }
}
