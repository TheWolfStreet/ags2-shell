import app from "ags/gtk4/app"
import { createState, For, createComputed, Accessor } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import Pango from "gi://Pango"
import GObject from "gi://GObject"
import env from "$lib/env"

const { BUTTON_PRIMARY, BUTTON_SECONDARY, DragAction, KEY_Escape } = Gdk
const { Orientation, GestureClick } = Gtk
const { START } = Gtk.Align
const { EllipsizeMode } = Pango
const { Justification } = Gtk
const { Layer, Exclusivity, WindowAnchor, Keymode } = Astal
const { TYPE_STRING } = GObject

export namespace Desktop {
	const [selected, setSelected] = createState<string[]>([])
	const [lastSelected, setLastSelected] = createState<string | null>(null)
	const [clipboard, setClipboard] = createState<{ operation: 'copy' | 'cut', files: string[] } | null>(null)
	const [isDraggingSelection, setIsDraggingSelection] = createState(false)
	const [selectionRect, setSelectionRect] = createState<{ x: number, y: number, width: number, height: number } | null>(null)
	const [order, setOrder] = createState<string[]>([])
	const [files, setFiles] = createState<DesktopFile[]>([])

	interface DesktopFile {
		name: string
		path: string
		type: string
		size?: number
		modified?: Date
		icon: string
	}

	function addToSelection(filePath: string) {
		setSelected(current => {
			if (!current.includes(filePath)) {
				return [...current, filePath]
			}
			return current
		})
		setLastSelected(filePath)
	}

	function removeFromSelection(filePath: string) {
		setSelected(current => current.filter(path => path !== filePath))
		if (lastSelected.get() === filePath) {
			setLastSelected(null)
		}
	}

	function toggleSelection(filePath: string) {
		const current = selected.get()
		if (current.includes(filePath)) {
			removeFromSelection(filePath)
		} else {
			addToSelection(filePath)
		}
	}

	function selectRange(filePath: string) {
		const allFiles = files.get()
		const currentOrder = order.get()
		const orderedPaths = currentOrder.length > 0 ? currentOrder : allFiles.map(f => f.path)

		const lastIdx = lastSelected.get() ? orderedPaths.indexOf(lastSelected.get()!) : -1
		const currentIdx = orderedPaths.indexOf(filePath)

		if (lastIdx === -1 || currentIdx === -1) {
			setSelected([filePath])
			setLastSelected(filePath)
			return
		}

		const startIdx = Math.min(lastIdx, currentIdx)
		const endIdx = Math.max(lastIdx, currentIdx)
		const rangeSelection = orderedPaths.slice(startIdx, endIdx + 1)

		setSelected(current => {
			const newSelection = [...current]
			rangeSelection.forEach(path => {
				if (!newSelection.includes(path)) {
					newSelection.push(path)
				}
			})
			return newSelection
		})
	}

	function selectByRectangleCoordinates(x1: number, y1: number, x2: number, y2: number) {
		const minX = Math.min(x1, x2)
		const maxX = Math.max(x1, x2)
		const minY = Math.min(y1, y2)
		const maxY = Math.max(y1, y2)

		const selectedFiles: string[] = []

		const allFiles = files.get()
		const currentOrder = order.get()
		const orderedFiles = currentOrder.length > 0 ?
			currentOrder.map(path => allFiles.find(f => f.path === path)).filter(Boolean) as DesktopFile[] :
			allFiles

		const cellSize = 120
		const rows = 8
		const gridStartX = 40
		const gridStartY = 40

		orderedFiles.forEach((file, index) => {
			const row = Math.floor(index / rows)
			const col = index % rows

			const iconX = gridStartX + (col * cellSize)
			const iconY = gridStartY + (row * cellSize)
			const iconRight = iconX + cellSize
			const iconBottom = iconY + cellSize

			if (iconRight >= minX && iconX <= maxX && iconBottom >= minY && iconY <= maxY) {
				selectedFiles.push(file.path)
			}
		})

		setSelected(selectedFiles)
		if (selectedFiles.length > 0) {
			setLastSelected(selectedFiles[selectedFiles.length - 1])
		}
	}

	function clearSelection() {
		setSelected([])
		setLastSelected(null)
	}

	function copyFiles(filePaths: string[]) {
		setClipboard({ operation: 'copy', files: filePaths })
		console.log('Copied files:', filePaths)
	}

	function cutFiles(filePaths: string[]) {
		setClipboard({ operation: 'cut', files: filePaths })
		console.log('Cut files:', filePaths)
	}

	async function pasteFiles(): Promise<boolean> {
		const clipboardData = clipboard.get()
		if (!clipboardData || clipboardData.files.length === 0) {
			return false
		}

		const desktopPath = env.paths.home + "/Desktop"

		try {
			for (const sourcePath of clipboardData.files) {
				const sourceFile = Gio.File.new_for_path(sourcePath)
				const fileName = sourceFile.get_basename()
				const targetPath = `${desktopPath}/${fileName}`
				const targetFile = Gio.File.new_for_path(targetPath)

				if (clipboardData.operation === 'copy') {
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
							}
						)
					})
				} else if (clipboardData.operation === 'cut') {
					sourceFile.move(targetFile, Gio.FileCopyFlags.NONE, null, null)
				}
			}

			if (clipboardData.operation === 'cut') {
				setClipboard(null)
			}

			setTimeout(() => {
				initFiles()
			}, 100)

			return true
		} catch (error) {
			console.error('Paste operation failed:', error)
			return false
		}
	}

	function deleteFiles(filePaths: string[]): Promise<boolean> {
		return new Promise((resolve) => {
			try {
				for (const filePath of filePaths) {
					const file = Gio.File.new_for_path(filePath)
					file.delete(null)
				}

				setTimeout(() => {
					initFiles()
				}, 100)

				resolve(true)
			} catch (error) {
				console.error('Delete operation failed:', error)
				resolve(false)
			}
		})
	}

	function renameFile(oldPath: string, newName: string): Promise<boolean> {
		return new Promise((resolve) => {
			try {
				const file = Gio.File.new_for_path(oldPath)
				const parent = file.get_parent()
				if (!parent) {
					resolve(false)
					return
				}

				const newPath = parent.get_path() + '/' + newName
				const newFile = Gio.File.new_for_path(newPath)

				file.move(newFile, Gio.FileCopyFlags.NONE, null, null)

				setTimeout(() => {
					initFiles()
				}, 100)

				resolve(true)
			} catch (error) {
				console.error('Rename operation failed:', error)
				resolve(false)
			}
		})
	}

	async function openFileWith(filePath: string) {
		try {
			const file = Gio.File.new_for_path(filePath)
			const uri = file.get_uri()

			Gio.app_info_launch_default_for_uri(uri, null)
		} catch (error) {
			console.error('Open with failed:', error)
		}
	}

	function createNewFolder(): Promise<boolean> {
		return new Promise((resolve) => {
			try {
				const desktopPath = env.paths.home + "/Desktop"
				let folderName = "New Folder"
				let counter = 1

				while (Gio.File.new_for_path(`${desktopPath}/${folderName}`).query_exists(null)) {
					folderName = `New Folder ${counter++}`
				}

				const newFolder = Gio.File.new_for_path(`${desktopPath}/${folderName}`)
				newFolder.make_directory(null)

				setTimeout(() => {
					initFiles()
				}, 100)

				resolve(true)
			} catch (error) {
				console.error('Create folder operation failed:', error)
				resolve(false)
			}
		})
	}

	function getFileType(path: string, isDir: boolean): string {
		if (isDir) return 'inode/directory'

		try {
			const file = Gio.File.new_for_path(path)
			const info = file.query_info('standard::content-type', Gio.FileQueryInfoFlags.NONE, null)
			const contentType = info.get_content_type()
			if (contentType) return contentType
		} catch { }

		const guessedType = Gio.content_type_guess(path, null)[0]
		return guessedType || 'application/octet-stream'
	}

	function getFileIcon(contentType: string): string {
		try {
			const typeIcon = Gio.content_type_get_icon(contentType) as Gio.ThemedIcon
			const iconNames = typeIcon.get_names()
			if (iconNames && iconNames.length > 0) {
				return iconNames[0]
			}
		} catch { }
		return 'text-x-generic'
	}

	function loadDesktopFiles(): DesktopFile[] {
		const desktopPath = env.paths.home + "/Desktop"
		const desktopDir = Gio.File.new_for_path(desktopPath)

		if (!desktopDir.query_exists(null)) return []

		try {
			const fileEnum = desktopDir.enumerate_children(
				'standard::name,standard::type,standard::size,time::modified',
				Gio.FileQueryInfoFlags.NONE,
				null
			)

			const foundFiles: DesktopFile[] = []
			let fileInfo: Gio.FileInfo | null

			while ((fileInfo = fileEnum.next_file(null)) !== null) {
				const fileName = fileInfo.get_name()
				if (fileName.startsWith('.')) continue

				const isDirectory = fileInfo.get_file_type() === Gio.FileType.DIRECTORY
				const filePath = desktopPath + '/' + fileName
				const fileType = getFileType(filePath, isDirectory)

				foundFiles.push({
					name: fileName,
					path: filePath,
					type: fileType,
					size: isDirectory ? undefined : fileInfo.get_size(),
					modified: new Date((fileInfo.get_modification_date_time()?.to_unix() || 0) * 1000),
					icon: getFileIcon(fileType)
				})
			}

			fileEnum.close(null)

			const sortedFiles = foundFiles.sort((fileA, fileB) => {
				const aIsFolder = fileA.type === 'inode/directory'
				const bIsFolder = fileB.type === 'inode/directory'

				if (aIsFolder && !bIsFolder) return -1
				if (!aIsFolder && bIsFolder) return 1
				return fileA.name.localeCompare(fileB.name)
			})

			return sortedFiles
		} catch {
			return []
		}
	}

	function initFiles() {
		const loaded = loadDesktopFiles()
		setFiles(loaded)

		const currentOrder = order.get()
		const hasNoOrder = currentOrder.length === 0
		const hasFiles = loaded.length > 0

		if (hasNoOrder && hasFiles) {
			const defaultOrder = loaded.map(file => file.path)
			setOrder(defaultOrder)
		}
	}

	initFiles()

	const orderedFiles = createComputed([files, order], (allFiles, userOrder) => {
		const hasNoOrder = userOrder.length === 0
		const hasNoFiles = allFiles.length === 0

		if (hasNoOrder || hasNoFiles) {
			return allFiles
		}

		const pathToFile = new Map(allFiles.map(file => [file.path, file]))
		const orderedList: DesktopFile[] = []

		userOrder.forEach(filePath => {
			const foundFile = pathToFile.get(filePath)
			if (foundFile) {
				orderedList.push(foundFile)
				pathToFile.delete(filePath)
			}
		})

		const remainingFiles = Array.from(pathToFile.values())
		remainingFiles.forEach(file => orderedList.push(file))

		return orderedList
	})

	const [showMenu, setShowMenu] = createState(false)
	const [menuPosition, setMenuPosition] = createState({ x: 0, y: 0 })

	function showContextMenu(x: number, y: number) {
		setMenuPosition({ x, y })
		setShowMenu(true)
	}

	function ContextMenu() {
		return (
			<box class="contents" orientation={Orientation.VERTICAL}>
				<button
					label="New Folder"
					halign={START}
					hexpand
					onClicked={() => {
						createNewFolder()
						setShowMenu(false)
					}}
				/>
				<button
					label="Refresh"
					halign={START}
					hexpand
					onClicked={() => {
						initFiles()
						setShowMenu(false)
					}}
				/>
			</box>
		)
	}

	function openFile(filePath: string) {
		try {
			const fileObj = Gio.File.new_for_path(filePath)
			Gio.app_info_launch_default_for_uri(fileObj.get_uri(), null)
		} catch { }
	}

	function SelectionRectangle() {
		return (
			<box
				visible={isDraggingSelection}
				class="selection-rectangle"
				widthRequest={selectionRect.as(rect => rect ? Math.abs(rect.width) : 0)}
				heightRequest={selectionRect.as(rect => rect ? Math.abs(rect.height) : 0)}
			/>
		)
	}

	function FileIcon({ file }: { file: DesktopFile }) {
		const [dragging, setDragging] = createState(false)

		const isSelected = selected.as(selectedPaths =>
			selectedPaths.includes(file.path)
		)

		const cssClass = createComputed([isSelected, dragging], (selected, isDragging) => {
			const baseClass = 'desktop-icon'
			const selectedClass = selected ? ' selected' : ''
			const draggingClass = isDragging ? ' dragging' : ''
			return baseClass + selectedClass + draggingClass
		})

		function handleClick(button: number, self: Gtk.GestureClick) {
			if (button === BUTTON_PRIMARY) {
				setSelected([file.path])
			}

			if (button === BUTTON_SECONDARY) {
				if (!selected.get().includes(file.path)) {
					setSelected([file.path])
				}
				const event = self.get_current_event()
				if (event) {
					const [success, x, y] = event.get_position()
					if (success) {
						showContextMenu(x, y)
					}
				}
			}
		}

		function handleDoubleClick() {
			try {
				const fileObj = Gio.File.new_for_path(file.path)
				Gio.app_info_launch_default_for_uri(fileObj.get_uri(), null)
			} catch { }
		}

		return (
			<box
				class={cssClass}
				orientation={Orientation.VERTICAL}
				$={(self: Gtk.Widget) => {
					const dragSource = Gtk.DragSource.new()
					dragSource.set_actions(DragAction.MOVE)

					dragSource.connect('prepare', (source, x, y) => {
						setDragging(true)
						setSelected([file.path])

						const dragIcon = Gtk.WidgetPaintable.new(self)
						source.set_icon(dragIcon, 40, 50)

						return Gdk.ContentProvider.new_for_value(file.path)
					})

					dragSource.connect('drag-end', () => {
						setDragging(false)
					})

					self.add_controller(dragSource)
				}}
			>
				<GestureClick
					button={0}
					onPressed={self => {
						const clickedButton = self.get_current_button()
						handleClick(clickedButton, self)
						self.reset()
					}}
				/>
				<GestureClick
					button={BUTTON_PRIMARY}
					onPressed={self => {
						const triggersContextMenu = self.get_current_event()?.triggers_context_menu()
						if (triggersContextMenu) return

						const lastClickTime = ((self as any)._lastClick as number) || 0
						const doubleClickThreshold = 400
						const isDoubleClick = Date.now() - lastClickTime < doubleClickThreshold

						if (isDoubleClick) {
							handleDoubleClick()
						}
						(self as any)._lastClick = Date.now()
					}}
				/>
				<image
					iconName={file.icon}
					pixelSize={64}
					useFallback
				/>
				<label
					class="desktop-icon-label"
					label={file.name}
					maxWidthChars={10}
					ellipsize={EllipsizeMode.END}
					justify={Justification.CENTER}
					wrap={false}
					lines={1}
				/>
			</box>
		)
	}

	function FileGrid() {
		const cellSize = 120
		const rows = 8

		return (
			<Gtk.Grid
				class="desktop-container"
			>
				<For each={orderedFiles}>
					{(file: DesktopFile, index: Accessor<number>) => {
						const itemIndex = index.get()
						const row = Math.floor(itemIndex / rows)
						const col = itemIndex % rows

						return (
							<box
								widthRequest={cellSize}
								heightRequest={cellSize}
								$={(self: Gtk.Widget) => {
									const grid = self.get_parent() as Gtk.Grid
									grid?.attach(self, col, row, 1, 1)

									const drop = Gtk.DropTarget.new(TYPE_STRING, DragAction.MOVE)
									drop.connect('drop', (_, draggedPath: string, _x: number, _y: number) => {
										setOrder(order => {
											const from = order.indexOf(draggedPath)
											const to = order.indexOf(file.path)

											if (from === -1 || from === to) return order

											const newOrder = [...order]
											const item = newOrder.splice(from, 1)[0]
											newOrder.splice(to, 0, item)
											return newOrder
										})
										return true
									})
									self.add_controller(drop)
								}}
							>
								<FileIcon file={file} />
							</box>
						)
					}}
				</For>
			</Gtk.Grid>
		)
	}

	export function ContextMenuWindow({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		return (
			<window
				name="desktop-context-menu"
				layer={Layer.TOP}
				exclusivity={Exclusivity.IGNORE}
				anchor={WindowAnchor.TOP | WindowAnchor.LEFT}
				application={app}
				gdkmonitor={gdkmonitor}
				visible={showMenu}
				keymode={Keymode.ON_DEMAND}
				marginLeft={menuPosition.as(pos => pos.x)}
				marginTop={menuPosition.as(pos => pos.y)}
			>
				<Gtk.EventControllerKey onKeyPressed={(_, keyval) => {
					if (keyval === KEY_Escape) {
						setShowMenu(false)
						return true
					}
					return false
				}} />
				<Gtk.GestureClick onPressed={() => setShowMenu(false)} />
				<ContextMenu />
			</window>
		) as Gtk.Window
	}

	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		return (
			<window
				name="desktop"
				namespace="desktop"
				layer={Layer.BACKGROUND}
				exclusivity={Exclusivity.IGNORE}
				anchor={WindowAnchor.TOP | WindowAnchor.BOTTOM | WindowAnchor.LEFT | WindowAnchor.RIGHT}
				application={app}
				gdkmonitor={gdkmonitor}
				visible={true}
				// NOTE: This isn't in the main style file because it flickers at start, not a real fix though, the style system needs to be reworked
				css="background: transparent;"
			>
				<GestureClick
					button={BUTTON_PRIMARY}
					onPressed={() => {
						setSelected([])
						setShowMenu(false)
					}}
				/>
				<GestureClick
					button={BUTTON_SECONDARY}
					onPressed={self => {
						setSelected([])
						const event = self.get_current_event()
						if (event) {
							const [success, x, y] = event.get_position()
							if (success) {
								showContextMenu(x, y)
							}
						}
					}}
				/>
				<Gtk.GestureDrag
					button={BUTTON_PRIMARY}
					onDragBegin={(self, x, y) => {
						setIsDraggingSelection(true)
						setSelectionRect({ x, y, width: 0, height: 0 })
						setShowMenu(false)
					}}
					onDragUpdate={(self, offsetX, offsetY) => {
						const rect = selectionRect.get()
						if (rect) {
							setSelectionRect({
								x: rect.x,
								y: rect.y,
								width: offsetX,
								height: offsetY
							})
							selectByRectangleCoordinates(rect.x, rect.y, rect.x + offsetX, rect.y + offsetY)
						}
					}}
					onDragEnd={(self, offsetX, offsetY) => {
						setIsDraggingSelection(false)
						const rect = selectionRect.get()
						if (rect && (Math.abs(offsetX) > 5 || Math.abs(offsetY) > 5)) {
							selectByRectangleCoordinates(rect.x, rect.y, rect.x + offsetX, rect.y + offsetY)
						}
						setSelectionRect(null)
					}}
				/>
				<overlay>
					<box
						class="desktop"
						orientation={Orientation.VERTICAL}
					>
						<FileGrid />
					</box>
					<Gtk.Fixed
						$type="overlay"
						hexpand
						vexpand
					>
						<SelectionRectangle $={self => {
							const fixed = self.get_parent() as Gtk.Fixed
							selectionRect.subscribe(() => {
								const rect = selectionRect.get()
								if (rect) {
									fixed?.move(self, Math.round(rect.x), Math.round(rect.y))
								} else {
									fixed?.put(self, 0, 0)
								}
							})
						}} />
					</Gtk.Fixed>
				</overlay>
			</window>
		) as Gtk.Window
	}
}
