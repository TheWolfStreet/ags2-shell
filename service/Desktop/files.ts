// Copies, moves, renames, removes, imports, and opens desktop files.

import { execAsync } from "ags/process"
import { timeout, Timer } from "ags/time"

import Gio from "gi://Gio"

import env from "$lib/env"
import { attempt } from "$lib/result"

export type DesktopFile = {
	name: string
	path: string
	type: string
	size?: number
	modified?: Date
	icon: string
}

const DESKTOP_PATH = `${env.paths.home}/Desktop`
const REFRESH_DELAY_MS = 100

let refreshTimer: Timer | null = null

function refreshSoon(refresh: () => void) {
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
): Promise<void | Error> {
	if (filePaths.length === 0)
		return

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

	refreshSoon(refresh)

	if (failures.length > 0) {
		return new Error(`Failed to import ${failures.length} item(s) onto desktop`, { cause: failures })
	}
}

export async function pasteFiles(paths: string[], operation: "copy" | "cut", refresh: () => void): Promise<void | Error> {
	if (paths.length === 0)
		return new Error("No files available in clipboard payload")

	try {
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

		refreshSoon(refresh)
	} catch (error) {
		return new Error("Failed to paste files onto desktop", { cause: error })
	}
}

function mutateDesktopFiles(
	paths: string[],
	refresh: () => void,
	mutate: (file: Gio.File) => boolean,
	failureMessage: string,
) {
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

	refreshSoon(refresh)
	if (failures.length > 0)
		return new Error(`${failureMessage} ${failures.length} item(s)`, { cause: failures })
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

export function renameFile(oldPath: string, newName: string, refresh: () => void): string | Error {
	const result = attempt((): string | Error => {
		const file = Gio.File.new_for_path(oldPath)
		const parent = file.get_parent()
		if (!parent)
			return new Error("Cannot rename file without parent directory")

		const parentPath = parent.get_path()
		if (!parentPath)
			return new Error("Cannot resolve parent path for rename")

		const newPath = `${parentPath}/${newName}`
		if (newPath === oldPath)
			return oldPath

		const newFile = Gio.File.new_for_path(newPath)
		if (newFile.query_exists(null))
			return new Error(`Target already exists: ${newPath}`)

		file.move(newFile, Gio.FileCopyFlags.NONE, null, null)
		refreshSoon(refresh)
		return newPath
	})

	if (!result.ok)
		return new Error(`Failed to rename ${oldPath}`, { cause: result.err })
	return result.value
}

export function createDesktopFolder(): string | Error {
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
		return new Error("Failed to create desktop folder", { cause: result.err })
	return result.value
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

export function loadDesktopFiles(): DesktopFile[] | Error {
	const desktopDir = Gio.File.new_for_path(DESKTOP_PATH)
	if (!desktopDir.query_exists(null))
		return []

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
				type: fileType,
				size: isDirectory ? undefined : fileInfo.get_size(),
				modified: new Date((fileInfo.get_modification_date_time()?.to_unix() || 0) * 1000),
				icon: iconNameFromFileInfo(fileInfo),
			})
		}

		fileEnum.close(null)

		return foundFiles.sort(compareDesktopFiles)
	})

	if (!result.ok)
		return new Error("Failed to scan desktop directory", { cause: result.err })
	return result.value
}

function compareDesktopFiles(left: DesktopFile, right: DesktopFile): number {
	const leftIsDirectory = left.type === "inode/directory"
	const rightIsDirectory = right.type === "inode/directory"
	if (leftIsDirectory && !rightIsDirectory) return -1
	if (!leftIsDirectory && rightIsDirectory) return 1
	return left.name.localeCompare(right.name)
}

export function openFile(filePath: string): void | Error {
	const result = attempt(() => {
		const fileObj = Gio.File.new_for_path(filePath)
		Gio.app_info_launch_default_for_uri(fileObj.get_uri(), null)
	})
	if (!result.ok)
		return new Error(`Failed to open ${filePath}`, { cause: result.err })
}
