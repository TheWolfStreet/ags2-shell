// Copies, moves, renames, removes, imports, and opens desktop files.

import { execAsync } from "ags/process"
import { Gdk, Gtk } from "ags/gtk4"

import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"
import Xdp from "gi://Xdp"
// XdpGtk4 is not emitted by the project's GIR type generator.
// @ts-expect-error missing generated declaration
import XdpGtk4 from "gi://XdpGtk4"

import env from "$lib/env"
import { attempt, attemptAsync, err, ok, type Result } from "$lib/result"

export type DesktopFile = {
	name: string
	displayName?: string
	path: string
	contentType: string
	size?: number
	modified?: Date
	icon: string
	iconFile?: string
}

export const DESKTOP_PATH = `${env.paths.home}/Desktop`

let portal: Xdp.Portal | null = null

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

async function copyRecursively(
	sourcePath: string,
	targetPath: string,
): Promise<boolean> {
	return execAsync(["gio", "copy", "--recursive", sourcePath, targetPath])
		.then(() => true)
		.catch(() => false)
}

type DesktopTransferResult = {
	createdPaths: string[]
	failures: Array<{ path: string; error: unknown }>
}

export async function importDesktopFiles(
	filePaths: string[],
	preferredOperation: "copy" | "move",
): Promise<DesktopTransferResult> {
	const createdPaths: string[] = []
	const failures: DesktopTransferResult["failures"] = []

	for (const sourcePath of filePaths) {
		try {
			const sourceFile = Gio.File.new_for_path(sourcePath)
			if (!sourceFile.query_exists(null)) continue

			const fileName = sourceFile.get_basename()
			if (!fileName) continue
			if (sourcePath === `${DESKTOP_PATH}/${fileName}`) continue

			const targetPath = uniqueDesktopTargetPath(fileName)
			let transferred = false

			if (preferredOperation === "move") {
				transferred = await execAsync(["gio", "move", sourcePath, targetPath])
					.then(() => true)
					.catch(() => false)
			}

			if (!transferred)
				transferred = await copyRecursively(sourcePath, targetPath)

			if (!transferred) {
				const targetFile = Gio.File.new_for_path(targetPath)
				if (preferredOperation === "move")
					sourceFile.move(targetFile, Gio.FileCopyFlags.NONE, null, null)
				else sourceFile.copy(targetFile, Gio.FileCopyFlags.NONE, null, null)
			}

			createdPaths.push(targetPath)
		} catch (error) {
			failures.push({ path: sourcePath, error })
		}
	}

	return { createdPaths, failures }
}

export async function pasteFilesToDesktop(
	paths: string[],
	operation: "copy" | "cut",
): Promise<DesktopTransferResult> {
	const createdPaths: string[] = []
	const failures: DesktopTransferResult["failures"] = []

	for (const sourcePath of paths) {
		try {
			const sourceFile = Gio.File.new_for_path(sourcePath)
			const fileName = sourceFile.get_basename()
			if (!fileName) continue

			const initialTargetPath = `${DESKTOP_PATH}/${fileName}`
			if (operation === "cut" && sourcePath === initialTargetPath) continue

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
			createdPaths.push(targetPath)
		} catch (error) {
			failures.push({ path: sourcePath, error })
		}
	}

	return { createdPaths, failures }
}

function mutateDesktopFiles(
	paths: string[],
	mutate: (file: Gio.File) => boolean,
	failureMessage: string,
): Result<void> {
	const failures: Array<{ path: string; error: unknown }> = []
	for (const path of paths) {
		const file = Gio.File.new_for_path(path)
		if (!file.query_exists(null)) continue

		const result = attempt(() => mutate(file))
		if (!result.ok) failures.push({ path, error: result.err })
		else if (!result.value)
			failures.push({ path, error: "operation returned false" })
	}

	if (failures.length > 0)
		return err(
			new Error(`${failureMessage} ${failures.length} item(s)`, {
				cause: failures,
			}),
		)
	return ok(undefined)
}

export function trashFiles(filePaths: string[]) {
	return mutateDesktopFiles(
		filePaths,
		(file) => file.trash(null),
		"Failed to trash",
	)
}

export function permanentlyDeleteFiles(filePaths: string[]) {
	return mutateDesktopFiles(
		filePaths,
		(file) => {
			file.delete(null)
			return true
		},
		"Failed to delete",
	)
}

export function renameFile(oldPath: string, newName: string): Result<string> {
	const result = attempt(() => {
		const file = Gio.File.new_for_path(oldPath)
		const parent = file.get_parent()
		if (!parent) throw new Error("Cannot rename file without parent directory")

		const parentPath = parent.get_path()
		if (!parentPath) throw new Error("Cannot resolve parent path for rename")

		const newPath = `${parentPath}/${newName}`
		if (newPath === oldPath) return oldPath

		const newFile = Gio.File.new_for_path(newPath)
		if (newFile.query_exists(null))
			throw new Error(`Target already exists: ${newPath}`)

		file.move(newFile, Gio.FileCopyFlags.NONE, null, null)
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

		while (
			Gio.File.new_for_path(`${DESKTOP_PATH}/${folderName}`).query_exists(null)
		) {
			folderName = `New Folder ${counter++}`
		}

		const newPath = `${DESKTOP_PATH}/${folderName}`
		const folder = Gio.File.new_for_path(newPath)
		folder.make_directory(null)

		return newPath
	})

	if (!result.ok)
		return err(
			new Error("Failed to create desktop folder", { cause: result.err }),
		)
	return result
}

export function createDesktopTextFile(): Result<string> {
	const result = attempt(() => {
		const path = uniqueDesktopTargetPath("New Text File.txt")
		const stream = Gio.File.new_for_path(path).create(
			Gio.FileCreateFlags.NONE,
			null,
		)
		stream.close(null)
		return path
	})

	if (!result.ok)
		return err(
			new Error("Failed to create desktop text file", { cause: result.err }),
		)
	return result
}

export type DesktopLauncherSpec = {
	name: string
	comment?: string
	command: string
	icon?: string
	workingDirectory?: string
	terminal?: boolean
}

function desktopLauncherFileName(name: string) {
	const stem = name
		.trim()
		.replace(/\.desktop$/i, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return `${stem || "launcher"}.desktop`
}

export function createDesktopLauncher(
	spec: DesktopLauncherSpec,
): Result<string> {
	const result = attempt(() => {
		const name = spec.name.trim()
		const command = spec.command.trim()
		if (!name) throw new Error("Launcher name is required")
		if (!command) throw new Error("Launcher command is required")

		const path = uniqueDesktopTargetPath(desktopLauncherFileName(name))
		const keyFile = new GLib.KeyFile()
		keyFile.set_string("Desktop Entry", "Type", "Application")
		keyFile.set_string("Desktop Entry", "Name", name)
		keyFile.set_string("Desktop Entry", "Exec", command)
		keyFile.set_boolean("Desktop Entry", "Terminal", !!spec.terminal)
		keyFile.set_boolean("Desktop Entry", "StartupNotify", true)
		if (spec.comment?.trim())
			keyFile.set_string("Desktop Entry", "Comment", spec.comment.trim())
		if (spec.icon?.trim())
			keyFile.set_string("Desktop Entry", "Icon", spec.icon.trim())
		if (spec.workingDirectory?.trim())
			keyFile.set_string("Desktop Entry", "Path", spec.workingDirectory.trim())

		const [contents] = keyFile.to_data()
		if (!GLib.file_set_contents(path, contents))
			throw new Error("Could not write launcher")

		const file = Gio.File.new_for_path(path)
		try {
			file.set_attribute_uint32(
				"unix::mode",
				0o755,
				Gio.FileQueryInfoFlags.NONE,
				null,
			)
			file.set_attribute_string(
				"metadata::trusted",
				"true",
				Gio.FileQueryInfoFlags.NONE,
				null,
			)
		} catch (error) {
			const cleanup = attempt(() => file.delete(null))
			if (!cleanup.ok)
				console.error(
					`desktop.createLauncher: Failed to remove incomplete launcher ${path}`,
					cleanup.err,
				)
			throw error
		}
		return path
	})

	if (!result.ok)
		return err(
			new Error("Failed to create desktop launcher", { cause: result.err }),
		)
	return result
}

function tryGetFileContentType(path: string) {
	const result = attempt(() => {
		const file = Gio.File.new_for_path(path)
		const info = file.query_info(
			"standard::content-type",
			Gio.FileQueryInfoFlags.NONE,
			null,
		)
		return info.get_content_type()
	})
	return result.ok ? result.value : null
}

function firstIconName(icon: Gio.Icon | null) {
	if (!icon) return null
	const getNames = Reflect.get(icon, "get_names")
	if (typeof getNames !== "function") return null
	const names = getNames.call(icon)
	return Array.isArray(names) && typeof names[0] === "string" ? names[0] : null
}

function tryGetContentTypeIconName(contentType: string) {
	const result = attempt(() =>
		firstIconName(Gio.content_type_get_icon(contentType)),
	)
	return result.ok ? result.value : null
}

function getFileType(path: string, isDir: boolean): string {
	if (isDir) return "inode/directory"

	const contentType = tryGetFileContentType(path)
	if (contentType) return contentType

	return Gio.content_type_guess(path, null)[0] || "application/octet-stream"
}

function iconNameFromFileInfo(info: Gio.FileInfo): string {
	const iconName = firstIconName(info.get_icon())
	if (iconName) return iconName

	const contentType = info.get_content_type()
	return contentType
		? (tryGetContentTypeIconName(contentType) ?? "text-x-generic")
		: "text-x-generic"
}

function desktopLauncherMetadata(path: string) {
	if (!path.toLowerCase().endsWith(".desktop")) return null
	const result = attempt(() => {
		const launcher = GioUnix.DesktopAppInfo.new_from_filename(path)
		if (!launcher) return null
		const iconName = firstIconName(launcher.get_icon())
		const iconValue = launcher.get_string("Icon") ?? ""
		let icon = iconName
		if (!icon && iconValue && !GLib.path_is_absolute(iconValue))
			icon = iconValue
		return {
			displayName: launcher.get_display_name() || launcher.get_name(),
			icon,
			iconFile: GLib.path_is_absolute(iconValue) ? iconValue : null,
		}
	})
	return result.ok ? result.value : null
}

export function loadDesktopFiles(): Result<DesktopFile[]> {
	const desktopDir = Gio.File.new_for_path(DESKTOP_PATH)
	if (!desktopDir.query_exists(null)) return ok([])

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
			if (fileName.startsWith(".")) continue

			const isDirectory = fileInfo.get_file_type() === Gio.FileType.DIRECTORY
			const filePath = `${DESKTOP_PATH}/${fileName}`
			const fileType =
				fileInfo.get_content_type() || getFileType(filePath, isDirectory)
			const launcher = desktopLauncherMetadata(filePath)

			foundFiles.push({
				name: fileName,
				displayName: launcher?.displayName,
				path: filePath,
				contentType: fileType,
				size: isDirectory ? undefined : fileInfo.get_size(),
				modified: new Date(
					(fileInfo.get_modification_date_time()?.to_unix() || 0) * 1000,
				),
				icon: launcher?.icon ?? iconNameFromFileInfo(fileInfo),
				iconFile: launcher?.iconFile ?? undefined,
			})
		}

		fileEnum.close(null)

		return foundFiles.sort(compareDesktopFiles)
	})

	if (!result.ok)
		return err(
			new Error("Failed to scan desktop directory", { cause: result.err }),
		)
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
		if (filePath.toLowerCase().endsWith(".desktop")) {
			const info = Gio.File.new_for_path(filePath).query_info(
				"access::can-execute,metadata::trusted",
				Gio.FileQueryInfoFlags.NONE,
				null,
			)
			const trusted = info.get_attribute_string("metadata::trusted") === "true"
			if (!trusted || !info.get_attribute_boolean("access::can-execute"))
				throw new Error("Refusing to launch an untrusted desktop entry")

			const launcher = GioUnix.DesktopAppInfo.new_from_filename(filePath)
			if (launcher) {
				launcher.launch([], null)
				return
			}
		}

		const fileObj = Gio.File.new_for_path(filePath)
		Gio.app_info_launch_default_for_uri(fileObj.get_uri(), null)
	})
	if (!result.ok)
		return err(new Error(`Failed to open ${filePath}`, { cause: result.err }))
	return result
}

export async function openPathWithChooser(
	filePath: string,
	window: Gtk.Window,
): Promise<Result<void>> {
	return new Promise((resolve) => {
		const started = attempt(() => {
			portal ??= Xdp.Portal.initable_new()
			const parent = XdpGtk4.parent_new_gtk(window)
			portal.open_uri(
				parent,
				Gio.File.new_for_path(filePath).get_uri(),
				Xdp.OpenUriFlags.ASK,
				null,
				(_source: unknown, result: Gio.AsyncResult) => {
					void parent
					const opened = attempt(() => portal!.open_uri_finish(result))
					if (opened.ok) {
						resolve(ok(undefined))
						return
					}

					const error = opened.err
					const cancelled =
						error instanceof GLib.Error &&
						error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED)
					if (cancelled) {
						resolve(ok(undefined))
						return
					}
					resolve(
						err(
							new Error(`Failed to open ${filePath} with application chooser`, {
								cause: error,
							}),
						),
					)
				},
			)
		})

		if (!started.ok)
			resolve(
				err(
					new Error(`Failed to open application chooser for ${filePath}`, {
						cause: started.err,
					}),
				),
			)
	})
}

export type ClipboardFilePayload = {
	operation: "copy" | "cut"
	files: string[]
}

type ClipboardOperation = ClipboardFilePayload["operation"]

function stringToBytes(value: string) {
	return new TextEncoder().encode(value)
}

function serializeClipboardFilePayload(
	paths: string[],
	operation: ClipboardOperation,
) {
	const files = paths.map((path) => Gio.File.new_for_path(path))
	const uris = files.map((file) => file.get_uri())
	return {
		files,
		uriList: `${uris.join("\r\n")}\r\n`,
		gnomePayload: `${operation}\n${uris.join("\n")}`,
	}
}

export function buildFileContentProvider(
	paths: string[],
	operation: ClipboardOperation,
) {
	const payload = serializeClipboardFilePayload(paths, operation)
	return Gdk.ContentProvider.new_union([
		Gdk.ContentProvider.new_for_value(
			Gdk.FileList.new_from_array(payload.files),
		),
		Gdk.ContentProvider.new_for_bytes(
			"text/uri-list",
			stringToBytes(payload.uriList),
		),
		Gdk.ContentProvider.new_for_bytes(
			"x-special/gnome-copied-files",
			stringToBytes(payload.gnomePayload),
		),
	])
}

export async function writeClipboardFilePayload(
	operation: ClipboardOperation,
	paths: string[],
): Promise<Result<void>> {
	if (paths.length === 0) return ok(undefined)

	const display = Gdk.Display.get_default()
	if (display) {
		const result = attempt(() =>
			display
				.get_clipboard()
				.set_content(buildFileContentProvider(paths, operation)),
		)
		if (!result.ok)
			return err(
				new Error("Failed to write desktop clipboard payload", {
					cause: result.err,
				}),
			)
		if (!result.value)
			return err(new Error("Failed to write desktop clipboard payload"))
		return ok(undefined)
	}

	const payload = serializeClipboardFilePayload(paths, operation)
	const primary = await attemptAsync(async () =>
		execAsync([
			"wl-copy",
			"-t",
			"x-special/gnome-copied-files",
			payload.gnomePayload,
		]),
	)
	if (primary.ok) return ok(undefined)

	const fallback = await attemptAsync(async () =>
		execAsync(["wl-copy", "-t", "text/uri-list", payload.uriList]),
	)
	if (fallback.ok) return ok(undefined)

	return err(
		new Error("Failed to write desktop clipboard payload", {
			cause: { primaryError: primary.err, fallbackError: fallback.err },
		}),
	)
}

export async function clearClipboardFilePayload(): Promise<Result<void>> {
	const display = Gdk.Display.get_default()
	if (display) {
		const result = attempt(() => display.get_clipboard().set_content(null))
		if (!result.ok)
			return err(
				new Error("Failed to clear desktop clipboard payload", {
					cause: result.err,
				}),
			)
		return result.value
			? ok(undefined)
			: err(new Error("Failed to clear desktop clipboard payload"))
	}

	const result = await attemptAsync(async () =>
		execAsync(["wl-copy", "--clear"]),
	)
	return result.ok
		? ok(undefined)
		: err(
				new Error("Failed to clear desktop clipboard payload", {
					cause: result.err,
				}),
			)
}

async function readClipboardMime(mimeType: string) {
	return execAsync(["wl-paste", "-t", mimeType]).catch(() => null)
}

function pathsFromUris(uris: string[]) {
	return uris
		.map((uri) => Gio.File.new_for_uri(uri).get_path())
		.filter((path): path is string => !!path)
}

export async function readClipboardFilePayload(): Promise<ClipboardFilePayload | null> {
	const copiedFiles = await readClipboardMime("x-special/gnome-copied-files")
	if (copiedFiles) {
		const lines = copiedFiles
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
		const files = pathsFromUris(lines.slice(1))
		if (files.length > 0) {
			let operation: ClipboardOperation = "copy"
			if (lines[0] === "cut") operation = "cut"
			return { operation, files }
		}
	}

	const uriList = await readClipboardMime("text/uri-list")
	if (!uriList) return null

	const files = pathsFromUris(
		uriList
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#")),
	)
	if (files.length === 0) return null
	return { operation: "copy", files }
}
