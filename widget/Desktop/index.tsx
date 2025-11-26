import app from "ags/gtk4/app"
import { createState, For, createComputed } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import Pango from "gi://Pango"
import GObject from "gi://GObject"
import env from "$lib/env"

const { BUTTON_PRIMARY, BUTTON_SECONDARY, DragAction } = Gdk
const { Orientation, GestureClick } = Gtk
const { EllipsizeMode } = Pango
const { Justification } = Gtk
const { Layer, Exclusivity, WindowAnchor } = Astal
const { TYPE_STRING } = GObject

export namespace Desktop {
	const [selected, setSelected] = createState<string[]>([])
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
			const typeIcon = Gio.content_type_get_icon(contentType)
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
					modified: new Date(fileInfo.get_modification_date_time()?.to_unix() * 1000 || 0),
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
		const loadedFiles = loadDesktopFiles()
		setFiles(loadedFiles)

		const currentOrder = order.get()
		const hasNoOrder = currentOrder.length === 0
		const hasFiles = loadedFiles.length > 0

		if (hasNoOrder && hasFiles) {
			const defaultOrder = loadedFiles.map(file => file.path)
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

		function handleClick(button: number) {
			if (button === BUTTON_PRIMARY) {
				setSelected([file.path])
			}

			if (button === BUTTON_SECONDARY) {
				// TODO: Context menu
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
				$={self => {
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
						handleClick(clickedButton)
						self.reset()
					}}
				/>
				<GestureClick
					button={BUTTON_PRIMARY}
					onPressed={self => {
						const triggersContextMenu = self.get_current_event()?.triggers_context_menu()
						if (triggersContextMenu) return

						const lastClickTime = (self as any)._lastClick || 0
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
								$={self => {
									const grid = self.get_parent() as Gtk.Grid
									grid?.attach(self, col, row, 1, 1)

									const drop = Gtk.DropTarget.new(TYPE_STRING, DragAction.MOVE)
									drop.connect('drop', (_, draggedPath, _x, _y) => {
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
				css="background: transparent;"
			>
				<GestureClick
					button={BUTTON_PRIMARY}
					onPressed={() => {
						setSelected([])
					}}
				/>
				<box class="desktop" orientation={Orientation.VERTICAL}>
					<FileGrid />
				</box>
			</window>
		) as Gtk.Window
	}
}
