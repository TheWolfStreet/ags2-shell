// Copies, moves, renames, removes, imports, and opens desktop files.

import { execAsync } from "ags/process"
import { Gdk } from "ags/gtk4"
import { timeout, Timer } from "ags/time"

import Gio from "gi://Gio"

import env from "$lib/env"
import { attempt, attemptAsync, err, ok, type Result } from "$lib/result"

export type DesktopFile = {
	name: string
	path: string
	contentType: string
	size?: number
	modified?: Date
	icon: string
}

const DESKTOP_PATH = `${env.paths.home}/Desktop`
const REFRESH_DELAY_MS = 100

let refreshTimer: Timer | null = null

function scheduleDesktopRefresh(refresh: () => void) {
	if (refreshTimer)
		refreshTimer.cancel()

	refreshTimer = timeout(REFRESH_DELAY_MS, () => {
		refreshTimer = null
		refresh()
	})
}

export function getDesktopPath() {
	return DESKTOP_PATH
}

function uniqueDesktopTargetPath(baseName: string) {
	const lastDot = baseName.lastIndexOf(".")
	const hasExt = lastDot > 0
	const stem = hasExt ? baseName.slice(0, lastDot) : baseName
	const ext = hasExt ? baseName.slice(lastDot) : ""
	let counter = 1
	let candidate = `${DESKTOP_PATH}/${baseName}`

	while (Gio.File.new_for_path(candidate).query_exists(null)) {
		candidate = `${DESKTOP_PATH}/${stem} (${counter++})${ext}`
	}

	return candidate
}

async function copyRecursively(sourcePath: string, targetPath: string): Promise<boolean> {
	return execAsync(["gio", "copy", "--recursive", sourcePath, targetPath])
		.then(() => true)
		.catch(() => false)
}

export async function importDesktopFiles(
	filePaths: string[],
	preferredOperation: "copy" | "move",
	refresh: () => void,
): Promise<Result<void>> {
	if (filePaths.length === 0)
		return ok(undefined)

	const failures: Array<{ path: string, error: unknown }> = []

	for (const sourcePath of filePaths) {
		try {
			const sourceFile = Gio.File.new_for_path(sourcePath)
			if (!sourceFile.query_exists(null))
				continue

			const fileName = sourceFile.get_basename()
			if (!fileName)
				continue

			const currentDesktopPath = `${DESKTOP_PATH}/${fileName}`
			if (sourcePath === currentDesktopPath)
				continue

			const targetPath = uniqueDesktopTargetPath(fileName)
			if (preferredOperation === "move") {
				const moved = await execAsync(["gio", "move", sourcePath, targetPath])
					.then(() => true)
					.catch(() => false)
				if (moved)
					continue

				const copied = await copyRecursively(sourcePath, targetPath)
				if (copied)
					continue
			} else {
				const copied = await copyRecursively(sourcePath, targetPath)
				if (copied)
					continue
			}

			const targetFile = Gio.File.new_for_path(targetPath)
			if (preferredOperation === "move") {
				sourceFile.move(targetFile, Gio.FileCopyFlags.NONE, null, null)
			} else {
				sourceFile.copy(targetFile, Gio.FileCopyFlags.NONE, null, null)
			}
		} catch (error) {
			failures.push({ path: sourcePath, error })
		}
	}

	scheduleDesktopRefresh(refresh)

	if (failures.length > 0) {
		return err(new Error(`Failed to import ${failures.length} item(s) onto desktop`, { cause: failures }))
	}
	return ok(undefined)
}

export async function pasteFilesToDesktop(paths: string[], operation: "copy" | "cut", refresh: () => void): Promise<Result<void>> {
	if (paths.length === 0)
		return err(new Error("No files available in clipboard payload"))

	const result = await attemptAsync(async () => {
		for (const sourcePath of paths) {
			const sourceFile = Gio.File.new_for_path(sourcePath)
			const fileName = sourceFile.get_basename()
			if (!fileName)
				continue

			const initialTargetPath = `${DESKTOP_PATH}/${fileName}`
			if (operation === "cut" && sourcePath === initialTargetPath)
				continue

			const targetPath = uniqueDesktopTargetPath(fileName)
			const targetFile = Gio.File.new_for_path(targetPath)

			if (operation === "copy") {
				await new Promise<void>((resolve, reject) => {
					sourceFile.copy_async(
						targetFile,
						Gio.FileCopyFlags.NONE,
						0,
						null,
						null,
						(source, result) => {
							try {
								source?.copy_finish(result)
								resolve()
							} catch (error) {
								reject(error)
							}
						},
					)
				})
			} else {
				sourceFile.move(targetFile, Gio.FileCopyFlags.NONE, null, null)
			}
		}

		scheduleDesktopRefresh(refresh)
	})
	return result.ok
		? result
		: err(new Error("Failed to paste files onto desktop", { cause: result.err }))
}

function mutateDesktopFiles(
	paths: string[],
	refresh: () => void,
	mutate: (file: Gio.File) => boolean,
	failureMessage: string,
): Result<void> {
	const failures: Array<{ path: string, error: unknown }> = []
	for (const path of paths) {
		const file = Gio.File.new_for_path(path)
		if (!file.query_exists(null))
			continue

		const result = attempt(() => mutate(file))
		if (!result.ok)
			failures.push({ path, error: result.err })
		else if (!result.value)
			failures.push({ path, error: "operation returned false" })
	}

	scheduleDesktopRefresh(refresh)
	if (failures.length > 0)
		return err(new Error(`${failureMessage} ${failures.length} item(s)`, { cause: failures }))
	return ok(undefined)
}

export function trashFiles(filePaths: string[], refresh: () => void) {
	return mutateDesktopFiles(filePaths, refresh, file => file.trash(null), "Failed to trash")
}

export function permanentlyDeleteFiles(filePaths: string[], refresh: () => void) {
	return mutateDesktopFiles(filePaths, refresh, file => {
		file.delete(null)
		return true
	}, "Failed to delete")
}

export function renameFile(oldPath: string, newName: string, refresh: () => void): Result<string> {
	const result = attempt(() => {
		const file = Gio.File.new_for_path(oldPath)
		const parent = file.get_parent()
		if (!parent)
			throw new Error("Cannot rename file without parent directory")

		const parentPath = parent.get_path()
		if (!parentPath)
			throw new Error("Cannot resolve parent path for rename")

		const newPath = `${parentPath}/${newName}`
		if (newPath === oldPath)
			return oldPath

		const newFile = Gio.File.new_for_path(newPath)
		if (newFile.query_exists(null))
			throw new Error(`Target already exists: ${newPath}`)

		file.move(newFile, Gio.FileCopyFlags.NONE, null, null)
		scheduleDesktopRefresh(refresh)
		return newPath
	})

	if (!result.ok)
		return err(new Error(`Failed to rename ${oldPath}`, { cause: result.err }))
	return result
}

export function createDesktopFolder(): Result<string> {
	const result = attempt(() => {
		let folderName = "New Folder"
		let counter = 1

		while (Gio.File.new_for_path(`${DESKTOP_PATH}/${folderName}`).query_exists(null)) {
			folderName = `New Folder ${counter++}`
		}

		const newPath = `${DESKTOP_PATH}/${folderName}`
		const folder = Gio.File.new_for_path(newPath)
		folder.make_directory(null)

		return newPath
	})

	if (!result.ok)
		return err(new Error("Failed to create desktop folder", { cause: result.err }))
	return result
}

function tryGetFileContentType(path: string) {
	const result = attempt(() => {
		const file = Gio.File.new_for_path(path)
		const info = file.query_info("standard::content-type", Gio.FileQueryInfoFlags.NONE, null)
		return info.get_content_type()
	})
	return result.ok ? result.value : null
}

function tryGetContentTypeIconName(contentType: string) {
	const result = attempt(() => {
		const icon = Gio.content_type_get_icon(contentType)
		const getNames = Reflect.get(icon, "get_names")
		if (typeof getNames !== "function")
			return null

		const names = getNames.call(icon)
		if (!Array.isArray(names) || typeof names[0] !== "string")
			return null
		return names[0]
	})
	return result.ok ? result.value : null
}

function getFileType(path: string, isDir: boolean): string {
	if (isDir)
		return "inode/directory"

	const contentType = tryGetFileContentType(path)
	if (contentType)
		return contentType

	return Gio.content_type_guess(path, null)[0] || "application/octet-stream"
}

function iconNameFromFileInfo(info: Gio.FileInfo): string {
	const icon = info.get_icon()
	const getNames = icon ? Reflect.get(icon, "get_names") : null
	if (typeof getNames === "function") {
		const names = getNames.call(icon)
		if (Array.isArray(names) && typeof names[0] === "string")
			return names[0]
	}

	const contentType = info.get_content_type()
	return contentType ? (tryGetContentTypeIconName(contentType) ?? "text-x-generic") : "text-x-generic"
}

export function loadDesktopFiles(): Result<DesktopFile[]> {
	const desktopDir = Gio.File.new_for_path(DESKTOP_PATH)
	if (!desktopDir.query_exists(null))
		return ok([])

	const result = attempt(() => {
		const fileEnum = desktopDir.enumerate_children(
			"standard::name,standard::type,standard::size,time::modified,standard::content-type,standard::icon",
			Gio.FileQueryInfoFlags.NONE,
			null,
		)

		const foundFiles: DesktopFile[] = []
		let fileInfo: Gio.FileInfo | null

		while ((fileInfo = fileEnum.next_file(null)) !== null) {
			const fileName = fileInfo.get_name()
			if (fileName.startsWith("."))
				continue

			const isDirectory = fileInfo.get_file_type() === Gio.FileType.DIRECTORY
			const filePath = `${DESKTOP_PATH}/${fileName}`
			const fileType = fileInfo.get_content_type() || getFileType(filePath, isDirectory)

			foundFiles.push({
				name: fileName,
				path: filePath,
				contentType: fileType,
				size: isDirectory ? undefined : fileInfo.get_size(),
				modified: new Date((fileInfo.get_modification_date_time()?.to_unix() || 0) * 1000),
				icon: iconNameFromFileInfo(fileInfo),
			})
		}

		fileEnum.close(null)

		return foundFiles.sort(compareDesktopFiles)
	})

	if (!result.ok)
		return err(new Error("Failed to scan desktop directory", { cause: result.err }))
	return result
}

function compareDesktopFiles(left: DesktopFile, right: DesktopFile): number {
	const leftIsDirectory = left.contentType === "inode/directory"
	const rightIsDirectory = right.contentType === "inode/directory"
	if (leftIsDirectory && !rightIsDirectory) return -1
	if (!leftIsDirectory && rightIsDirectory) return 1
	return left.name.localeCompare(right.name)
}

export function openPath(filePath: string): Result<void> {
	const result = attempt(() => {
		const fileObj = Gio.File.new_for_path(filePath)
		Gio.app_info_launch_default_for_uri(fileObj.get_uri(), null)
	})
	if (!result.ok)
		return err(new Error(`Failed to open ${filePath}`, { cause: result.err }))
	return result
}

export type ClipboardFilePayload = {
	operation: "copy" | "cut"
	files: string[]
}

type ClipboardOperation = ClipboardFilePayload["operation"]

function stringToBytes(value: string) {
	return new TextEncoder().encode(value)
}

function serializeClipboardFilePayload(paths: string[], operation: ClipboardOperation) {
	const files = paths.map(path => Gio.File.new_for_path(path))
	const uris = files.map(file => file.get_uri())
	return {
		files,
		uriList: `${uris.join("\r\n")}\r\n`,
		gnomePayload: `${operation}\n${uris.join("\n")}`,
	}
}

export function buildFileContentProvider(paths: string[], operation: ClipboardOperation) {
	const payload = serializeClipboardFilePayload(paths, operation)
	return Gdk.ContentProvider.new_union([
		Gdk.ContentProvider.new_for_value(Gdk.FileList.new_from_array(payload.files)),
		Gdk.ContentProvider.new_for_bytes("text/uri-list", stringToBytes(payload.uriList)),
		Gdk.ContentProvider.new_for_bytes("x-special/gnome-copied-files", stringToBytes(payload.gnomePayload)),
	])
}

export async function writeClipboardFilePayload(operation: ClipboardOperation, paths: string[]): Promise<Result<void>> {
	if (paths.length === 0)
		return ok(undefined)

	const display = Gdk.Display.get_default()
	if (display) {
		const result = attempt(() => display.get_clipboard().set_content(buildFileContentProvider(paths, operation)))
		if (!result.ok)
			return err(new Error("Failed to write desktop clipboard payload", { cause: result.err }))
		if (!result.value)
			return err(new Error("Failed to write desktop clipboard payload"))
		return ok(undefined)
	}

	const payload = serializeClipboardFilePayload(paths, operation)
	const primary = await attemptAsync(async () => execAsync(["wl-copy", "-t", "x-special/gnome-copied-files", payload.gnomePayload]))
	if (primary.ok)
		return ok(undefined)

	const fallback = await attemptAsync(async () => execAsync(["wl-copy", "-t", "text/uri-list", payload.uriList]))
	if (fallback.ok)
		return ok(undefined)

	return err(new Error("Failed to write desktop clipboard payload", {
		cause: { primaryError: primary.err, fallbackError: fallback.err },
	}))
}

export async function clearClipboardFilePayload(): Promise<Result<void>> {
	const display = Gdk.Display.get_default()
	if (display) {
		const result = attempt(() => display.get_clipboard().set_content(null))
		if (!result.ok)
			return err(new Error("Failed to clear desktop clipboard payload", { cause: result.err }))
		return result.value
			? ok(undefined)
			: err(new Error("Failed to clear desktop clipboard payload"))
	}

	const result = await attemptAsync(async () => execAsync(["wl-copy", "--clear"]))
	return result.ok
		? ok(undefined)
		: err(new Error("Failed to clear desktop clipboard payload", { cause: result.err }))
}

async function readClipboardMime(mimeType: string) {
	return execAsync(["wl-paste", "-t", mimeType]).catch(() => null)
}

function pathsFromUris(uris: string[]) {
	return uris
		.map(uri => Gio.File.new_for_uri(uri).get_path())
		.filter((path): path is string => !!path)
}

export async function readClipboardFilePayload(): Promise<ClipboardFilePayload | null> {
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
