// Creates application launchers on the desktop with guided application and icon selection.

import app from "ags/gtk4/app"
import {
	createBinding,
	createComputed,
	createRoot,
	createState,
	For,
	onCleanup,
	type Accessor,
} from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { applications } from "$service/apps"
import icons from "$lib/icons"
import { isDialogDismissed } from "$lib/ui"
import { ApplicationIcon } from "widget/shared/ApplicationIcon"
import { Placeholder } from "widget/shared/Placeholder"
import { createDesktopLauncherOn, desktopInteraction } from "../Desktop"

export namespace DesktopLauncherCreator {
	export function open(monitorId: string) {
		creatorSession += 1
		reset()
		setTargetMonitor(monitorId)
		ensureWindow()?.present()
	}

	export function Window() {
		const existing = app.get_window("desktop-launcher-creator")
		if (existing) return existing

		const createBlockedReason = createComputed(() => {
			const missingName = !name().trim()
			const missingCommand = !command().trim()
			if (missingName && missingCommand)
				return "Enter a launcher name and command."
			if (missingName) return "Enter a launcher name."
			if (missingCommand) return "Enter a command or choose an application."
			return ""
		})
		const canCreate = createBlockedReason.as((reason) => !reason)
		const createTooltip = createBlockedReason.as(
			(reason) => reason || "Create the launcher on the desktop",
		)
		const volumeMonitor = Gio.VolumeMonitor.get()
		const [volumeOptions, setVolumeOptions] = createState<VolumeOption[]>([])
		const [mountingVolume, setMountingVolume] = createState("")
		function syncVolumes() {
			setVolumeOptions(
				volumeMonitor
					.get_volumes()
					.map((volume) => {
						const mount = volume.get_mount()
						const root = mount?.get_root()
						const target = root?.get_path() ?? root?.get_uri() ?? ""
						const canMount = volume.can_mount()
						return {
							key:
								volume.get_uuid() ??
								volume.get_identifier(Gio.VOLUME_IDENTIFIER_KIND_UNIX_DEVICE) ??
								volume.get_name(),
							volume,
							name: volume.get_name(),
							detail: target || (canMount ? "Not mounted" : "Unavailable"),
							icon: volume.get_symbolic_icon(),
							target,
							canMount,
						}
					})
					.filter((option) => option.target || option.canMount)
					.sort((left, right) => left.name.localeCompare(right.name)),
			)
		}
		syncVolumes()
		const volumeHandlers = [
			volumeMonitor.connect("volume-added", syncVolumes),
			volumeMonitor.connect("volume-removed", syncVolumes),
			volumeMonitor.connect("volume-changed", syncVolumes),
			volumeMonitor.connect("mount-added", syncVolumes),
			volumeMonitor.connect("mount-removed", syncVolumes),
			volumeMonitor.connect("mount-changed", syncVolumes),
		]
		onCleanup(() =>
			volumeHandlers.forEach((handler) => volumeMonitor.disconnect(handler)),
		)
		const allApplications = createBinding(applications, "list")
		const applicationModel = Gio.ListStore.new(AstalApps.Application.$gtype)
		let applicationQuery = ""
		const applicationSearchIndex = new WeakMap<AstalApps.Application, string>()
		const catalogSorter = Gtk.CustomSorter.new((left, right) => {
			const leftApplication = left as unknown as AstalApps.Application
			const rightApplication = right as unknown as AstalApps.Application

			const frequencyDifference =
				rightApplication.get_frequency() - leftApplication.get_frequency()
			if (frequencyDifference < 0) return Gtk.Ordering.SMALLER
			if (frequencyDifference > 0) return Gtk.Ordering.LARGER
			const nameDifference = leftApplication
				.get_name()
				.localeCompare(rightApplication.get_name())
			return nameDifference < 0
				? Gtk.Ordering.SMALLER
				: nameDifference > 0
					? Gtk.Ordering.LARGER
					: Gtk.Ordering.EQUAL
		})
		const sortedApplications = Gtk.SortListModel.new(
			applicationModel,
			catalogSorter,
		)
		sortedApplications.set_incremental(true)
		const catalogFilter = Gtk.CustomFilter.new((item) => {
			if (!(item instanceof AstalApps.Application)) return false
			let searchable = applicationSearchIndex.get(item)
			if (searchable === undefined) {
				searchable = [
					item.get_name(),
					item.get_description(),
					item.get_executable(),
				]
					.filter(Boolean)
					.join("\n")
					.toLowerCase()
				applicationSearchIndex.set(item, searchable)
			}
			return !applicationQuery || searchable.includes(applicationQuery)
		})
		const filteredApplications = Gtk.FilterListModel.new(
			sortedApplications,
			catalogFilter,
		)
		filteredApplications.set_incremental(false)
		const applicationSelection = Gtk.NoSelection.new(filteredApplications)
		const applicationFactory = Gtk.SignalListItemFactory.new()
		const applicationCells = new WeakMap<
			Gtk.ListItem,
			ReturnType<typeof createApplicationCell>
		>()
		let applicationGrid: Gtk.GridView | null = null
		let applicationOpenPending = false

		function syncApplications() {
			applicationModel.splice(
				0,
				applicationModel.get_n_items(),
				allApplications.peek(),
			)
		}
		syncApplications()
		onCleanup(allApplications.subscribe(syncApplications))

		const display = Gdk.Display.get_default()
		const iconNames = display
			? Gtk.IconTheme.get_for_display(display).get_icon_names()
			: []
		const iconModel = Gtk.StringList.new(iconNames)
		const iconExpression = Gtk.PropertyExpression.new(
			Gtk.StringObject.$gtype,
			null,
			"string",
		)
		const iconBaseSelection = Gtk.NoSelection.new(iconModel)
		const iconFilteredSelections = [
			Gtk.NoSelection.new(null),
			Gtk.NoSelection.new(null),
		]
		const [iconResultsPage, setIconResultsPage] =
			createState<IconResultsPage>("all")
		const iconFactory = Gtk.SignalListItemFactory.new()
		const iconCells = new WeakMap<
			Gtk.ListItem,
			{ image: Gtk.Image; label: Gtk.Label }
		>()
		let iconBaseGrid: Gtk.GridView | null = null
		const iconFilteredGrids: Array<Gtk.GridView | null> = [null, null]
		let iconQuery = ""
		let activeIconFilterSlot = -1
		let pendingIconModel: Gtk.FilterListModel | null = null
		let pendingIconHandler = 0

		iconFactory.connect("setup", (_factory, object) => {
			const item = object as Gtk.ListItem
			const image = new Gtk.Image({ pixelSize: 32 })
			const label = new Gtk.Label({ ellipsize: 3 })
			const cell = new Gtk.Box({ orientation: VERTICAL })
			cell.add_css_class("icon-option")
			cell.set_halign(CENTER)
			cell.set_valign(CENTER)
			cell.append(image)
			cell.append(label)
			item.set_activatable(true)
			item.set_child(cell)
			iconCells.set(item, { image, label })
		})
		iconFactory.connect("bind", (_factory, object) => {
			const item = object as Gtk.ListItem
			const value = item.get_item()
			const cell = iconCells.get(item)
			if (!(value instanceof Gtk.StringObject) || !cell) return
			const iconName = value.get_string()
			cell.image.set_from_icon_name(iconName)
			cell.label.set_label(iconName)
			item.get_child()?.set_tooltip_text(iconName)
		})

		function updateIconQuery(value: string) {
			setIconSearch(value)
			const nextQuery = value.trim()
			if (nextQuery === iconQuery) {
				resetActiveIconAnchor()
				return
			}
			iconQuery = nextQuery
			cancelPendingIconFilter()
			if (!nextQuery) {
				setIconResultsPage("all")
				iconBaseGrid?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
				return
			}

			const slot = activeIconFilterSlot === 0 ? 1 : 0
			const filter = Gtk.StringFilter.new(iconExpression)
			filter.set_ignore_case(true)
			filter.set_match_mode(Gtk.StringFilterMatchMode.SUBSTRING)
			filter.set_search(nextQuery)
			const candidate = Gtk.FilterListModel.new(null, filter)
			candidate.set_incremental(true)
			iconFilteredSelections[slot].set_model(candidate)
			pendingIconModel = candidate
			const finish = () => {
				if (pendingIconModel !== candidate || candidate.get_pending() > 0)
					return
				candidate.disconnect(pendingIconHandler)
				pendingIconHandler = 0
				pendingIconModel = null
				if (candidate.get_n_items() === 0) {
					setIconResultsPage("empty")
					return
				}
				activeIconFilterSlot = slot
				iconFilteredGrids[slot]?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
				setIconResultsPage(slot === 0 ? "filtered-a" : "filtered-b")
			}
			pendingIconHandler = candidate.connect("notify::pending", finish)
			candidate.set_model(iconModel)
			finish()
		}
		function cancelPendingIconFilter() {
			if (!pendingIconModel) return
			if (pendingIconHandler) pendingIconModel.disconnect(pendingIconHandler)
			pendingIconModel.set_model(null)
			pendingIconModel = null
			pendingIconHandler = 0
		}
		function resetActiveIconAnchor() {
			const current = iconResultsPage.peek()
			if (current === "all")
				iconBaseGrid?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
			if (current === "filtered-a")
				iconFilteredGrids[0]?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
			if (current === "filtered-b")
				iconFilteredGrids[1]?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
		}
		function openIconSelector() {
			applicationOpenPending = false
			updateIconQuery("")
			setPage("icons")
		}
		onCleanup(cancelPendingIconFilter)
		function updateApplicationQuery(value: string) {
			setApplicationSearch(value)
			const nextQuery = value.trim().toLowerCase()
			if (nextQuery === applicationQuery) {
				resetApplicationAnchor()
				return
			}
			applicationQuery = nextQuery
			catalogFilter.changed(Gtk.FilterChange.DIFFERENT)
			resetApplicationAnchor()
		}
		function resetApplicationAnchor() {
			if (applicationSelection.get_n_items() > 0)
				applicationGrid?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
		}
		function openApplicationSelector() {
			cancelPendingIconFilter()
			applicationOpenPending = true
			updateApplicationQuery("")
			finishOpeningApplicationSelector()
		}
		function finishOpeningApplicationSelector() {
			if (!applicationOpenPending) return
			idle(() => {
				if (
					!applicationOpenPending ||
					filteredApplications.get_pending() > 0 ||
					sortedApplications.get_pending() > 0
				)
					return
				resetApplicationAnchor()
				applicationOpenPending = false
				setPage("applications")
			})
		}
		function openLocationSelector() {
			applicationOpenPending = false
			cancelPendingIconFilter()
			syncVolumes()
			setErrorMessage("")
			setPage("locations")
		}
		const filterPendingHandler = filteredApplications.connect(
			"notify::pending",
			finishOpeningApplicationSelector,
		)
		const sortPendingHandler = sortedApplications.connect(
			"notify::pending",
			finishOpeningApplicationSelector,
		)
		onCleanup(() => {
			filteredApplications.disconnect(filterPendingHandler)
			sortedApplications.disconnect(sortPendingHandler)
		})
		const selectedApplicationName = applicationLabel.as(
			(value) => value.trim() || "Choose",
		)
		const workingDirectoryLabel = workingDirectory.as(
			(path) => path.trim().split("/").pop() || "Choose",
		)
		const directoryTarget = createComputed(
			() => targetKind() === "location" || commandTargetsDirectory(command()),
		)
		const showApplicationOptions = directoryTarget.as((directory) => !directory)
		const hasApplicationOptions = createBinding(
			filteredApplications,
			"nItems",
		).as(Boolean)
		const showApplicationEmpty = hasApplicationOptions.as(
			(hasOptions) => !hasOptions,
		)
		const hasVolumeOptions = volumeOptions.as((options) => options.length > 0)
		const headerTitle = page.as((current) =>
			current === "applications"
				? "Choose a Target"
				: current === "locations"
					? "Choose a Folder or Disk"
					: current === "icons"
						? "Choose an Icon"
						: "Create a Desktop Launcher",
		)

		function selectApplication(application: AstalApps.Application) {
			setApplicationLabel(application.get_name())
			setName(application.get_name())
			setComment(application.get_description() || "")
			setCommand(application.get_executable() || "")
			setIcon(application.get_icon_name() || "application-x-executable")
			setWorkingDirectory(application.get_key("Path") || "")
			setTerminal(application.get_key("Terminal")?.toLowerCase() === "true")
			setTargetKind("application")
			setPage("form")
		}

		function createApplicationCell() {
			return createRoot((dispose) => {
				const [cellIcon, setCellIcon] = createState(
					"application-x-executable-symbolic",
				)
				let currentApplication: AstalApps.Application | null = null
				let title!: Gtk.Label
				let detail!: Gtk.Label
				const widget = (
					<button
						class="application-option"
						halign={FILL}
						hexpand
						onClicked={() => {
							if (currentApplication) selectApplication(currentApplication)
						}}
					>
						<box orientation={HORIZONTAL}>
							<ApplicationIcon icon={cellIcon} size={40} />
							<box
								class="option-copy"
								orientation={VERTICAL}
								valign={CENTER}
								hexpand
							>
								<label
									$={(self) => (title = self)}
									class="option-title"
									xalign={0}
									ellipsize={3}
								/>
								<label
									$={(self) => (detail = self)}
									class="option-detail"
									xalign={0}
									ellipsize={3}
								/>
							</box>
						</box>
					</button>
				) as Gtk.Button

				return {
					widget,
					bind(
						application: AstalApps.Application,
						position: number,
						count: number,
					) {
						currentApplication = application
						widget.remove_css_class("first")
						widget.remove_css_class("last")
						if (position === 0) widget.add_css_class("first")
						if (position === count - 1) widget.add_css_class("last")
						setCellIcon(
							application.get_icon_name() ||
								"application-x-executable-symbolic",
						)
						title.set_label(application.get_name())
						detail.set_label(
							application.get_description() || application.get_executable(),
						)
					},
					clear() {
						currentApplication = null
					},
					dispose,
				}
			})
		}

		applicationFactory.connect("setup", (_factory, object) => {
			const item = object as Gtk.ListItem
			const cell = createApplicationCell()
			item.set_activatable(false)
			item.set_selectable(false)
			item.set_child(cell.widget)
			applicationCells.set(item, cell)
		})
		applicationFactory.connect("bind", (_factory, object) => {
			const item = object as Gtk.ListItem
			const application = item.get_item()
			const cell = applicationCells.get(item)
			if (!(application instanceof AstalApps.Application) || !cell) return
			cell.bind(
				application,
				item.get_position(),
				applicationSelection.get_n_items(),
			)
		})
		applicationFactory.connect("unbind", (_factory, object) => {
			const item = object as Gtk.ListItem
			applicationCells.get(item)?.clear()
		})
		applicationFactory.connect("teardown", (_factory, object) => {
			const item = object as Gtk.ListItem
			const cell = applicationCells.get(item)
			if (!cell) return
			cell.dispose()
			item.set_child(null)
			applicationCells.delete(item)
		})

		function IconResultsGrid({
			selection,
			visible,
			setGrid,
		}: {
			selection: Gtk.NoSelection
			visible: Accessor<boolean>
			setGrid: (grid: Gtk.GridView) => void
		}) {
			return (
				<Gtk.ScrolledWindow
					visible={visible}
					vexpand
					hscrollbarPolicy={Gtk.PolicyType.NEVER}
				>
					<Gtk.GridView
						class="icon-grid"
						model={selection}
						factory={iconFactory}
						minColumns={5}
						maxColumns={8}
						singleClickActivate
						$={(self) => {
							setGrid(self)
							self.connect("activate", (_grid, position) => {
								const value = selection.get_item(position)
								if (!(value instanceof Gtk.StringObject)) return
								setIcon(value.get_string())
								setPage("form")
							})
						}}
					/>
				</Gtk.ScrolledWindow>
			)
		}

		function selectAnotherApplication() {
			chooseFile(
				"Choose application",
				(path) => {
					const baseName = path.split("/").pop() || "Application"
					setApplicationLabel(baseName)
					if (!name.peek().trim()) setName(baseName)
					setCommand(quoteExecArgument(path))
					if (!icon.peek().trim()) setIcon("application-x-executable")
					setTargetKind("application")
					setPage("form")
				},
				applicationFilter,
			)
		}

		function selectLocation(name: string, target: string, iconName: string) {
			setApplicationLabel(name)
			setName(name)
			setComment(`Open ${name}`)
			setCommand(`xdg-open ${quoteExecArgument(target)}`)
			setIcon(iconName)
			setTargetKind("location")
			setErrorMessage("")
			setPage("form")
		}

		function selectVolume(option: VolumeOption) {
			if (option.target) {
				selectLocation(
					option.name,
					option.target,
					launcherIconName(option.icon, "drive-harddisk-symbolic"),
				)
				return
			}
			if (!option.canMount || mountingVolume.peek()) return

			setMountingVolume(option.key)
			setErrorMessage("")
			const session = creatorSession
			const parent = app.get_window("desktop-launcher-creator")
			const operation = Gtk.MountOperation.new(parent)
			option.volume.mount(
				Gio.MountMountFlags.NONE,
				operation,
				null,
				(_volume, result) => {
					try {
						option.volume.mount_finish(result)
						if (session !== creatorSession) return
						const root = option.volume.get_mount()?.get_root()
						const target = root?.get_path() ?? root?.get_uri()
						if (!target)
							throw new Error("Mounted volume has no accessible location")
						selectLocation(
							option.name,
							target,
							launcherIconName(option.icon, "drive-harddisk-symbolic"),
						)
					} catch (error) {
						if (session !== creatorSession) return
						setErrorMessage(`Could not mount ${option.name}. ${error}`)
					} finally {
						if (session === creatorSession) {
							setMountingVolume("")
							syncVolumes()
						}
					}
				},
			)
		}

		function selectFolderShortcut() {
			chooseDirectory((path) => {
				const mounted = volumeOptions
					.peek()
					.find((option) => option.target === path)
				const folderName =
					path.replace(/\/+$/, "").split("/").pop() || "Filesystem"
				selectLocation(
					mounted?.name ?? folderName,
					path,
					mounted
						? launcherIconName(mounted.icon, "drive-harddisk-symbolic")
						: folderIconName(path),
				)
			}, "Choose a folder or mounted disk")
		}

		function selectImageIcon() {
			chooseFile(
				"Choose launcher image",
				(path) => {
					setIcon(path)
					setPage("form")
				},
				imageFilter,
			)
		}

		function create() {
			setErrorMessage("")
			const isDirectory = directoryTarget.peek()
			const path = createDesktopLauncherOn(targetMonitor.peek(), {
				name: name.peek(),
				comment: comment.peek(),
				command: command.peek(),
				icon: icon.peek(),
				workingDirectory: isDirectory ? "" : workingDirectory.peek(),
				terminal: isDirectory ? false : terminal.peek(),
			})
			if (!path) {
				setErrorMessage(
					"Could not create the launcher. Check the selected application and try again.",
				)
				return
			}

			desktopInteraction.select([path])
			app.get_window("desktop-launcher-creator")?.hide()
			reset()
		}

		const formPage = (
			<box orientation={VERTICAL} vexpand>
				<box class="launcher-form" orientation={VERTICAL}>
					<box class="launcher-editor" orientation={VERTICAL}>
						<box class="identity-row editor-row" orientation={HORIZONTAL}>
							<Gtk.AspectFrame
								widthRequest={72}
								heightRequest={72}
								ratio={1}
								obeyChild={false}
								hexpand={false}
								vexpand={false}
								halign={CENTER}
								valign={CENTER}
							>
								<button
									class="icon-editor"
									tooltipText="Choose icon"
									halign={FILL}
									valign={FILL}
									onClicked={openIconSelector}
								>
									<ApplicationIcon
										icon={icon.as(
											(value) => value || "application-x-executable-symbolic",
										)}
										size={48}
									/>
								</button>
							</Gtk.AspectFrame>
							<box
								class="identity-inputs"
								orientation={VERTICAL}
								valign={CENTER}
								hexpand
							>
								<entry
									text={name}
									placeholderText="New Launcher"
									onNotifyText={(self) => setName(self.text)}
								/>
								<entry
									text={comment}
									placeholderText="Add a description"
									onNotifyText={(self) => setComment(self.text)}
								/>
							</box>
						</box>

						<Gtk.Separator />
						<box class="application-row editor-row" orientation={HORIZONTAL}>
							<label label="Target" xalign={0} hexpand />
							<button
								class="application-picker"
								onClicked={openApplicationSelector}
							>
								<box orientation={HORIZONTAL}>
									<label label={selectedApplicationName} ellipsize={3} />
									<image iconName="go-next-symbolic" />
								</box>
							</button>
						</box>

						<Gtk.Separator />
						<box class="command-row editor-row" orientation={HORIZONTAL}>
							<label label="Command" xalign={0} />
							<entry
								text={command}
								placeholderText="application --option"
								hexpand
								onNotifyText={(self) => {
									const manuallyEdited = self.text !== command.peek()
									setCommand(self.text)
									if (manuallyEdited) setTargetKind("custom")
								}}
							/>
						</box>

						<Gtk.Separator visible={showApplicationOptions} />
						<box
							class="working-folder-row editor-row"
							orientation={HORIZONTAL}
							visible={showApplicationOptions}
						>
							<label label="Working Directory" xalign={0} hexpand />
							<box class="folder-control" orientation={HORIZONTAL}>
								<button
									class="folder-picker"
									tooltipText={workingDirectory}
									onClicked={() => chooseDirectory(setWorkingDirectory)}
								>
									<box orientation={HORIZONTAL}>
										<image iconName="folder-symbolic" />
										<label label={workingDirectoryLabel} ellipsize={3} />
									</box>
								</button>
								<button
									class="clear-folder"
									tooltipText="Use application default"
									visible={workingDirectory.as(Boolean)}
									onClicked={() => setWorkingDirectory("")}
								>
									<image iconName="edit-clear-symbolic" />
								</button>
							</box>
						</box>

						<Gtk.Separator visible={showApplicationOptions} />
						<box
							class="terminal-row editor-row"
							orientation={HORIZONTAL}
							visible={showApplicationOptions}
						>
							<label label="Run in Terminal" xalign={0} hexpand />
							<switch
								active={terminal}
								valign={CENTER}
								onNotifyActive={(self) => setTerminal(self.active)}
							/>
						</box>
					</box>

					<label
						class="error"
						label={errorMessage}
						visible={errorMessage.as(Boolean)}
						xalign={0}
						wrap
					/>
				</box>

				<box vexpand />
				<box class="actions" orientation={HORIZONTAL} halign={FILL} hexpand>
					<box hexpand />
					<button
						label="Cancel"
						onClicked={() => app.get_window("desktop-launcher-creator")?.hide()}
					/>
					<box tooltipText={createTooltip}>
						<button
							class="suggested-action"
							label="Create Launcher"
							sensitive={canCreate}
							onClicked={create}
						/>
					</box>
				</box>
			</box>
		)

		const applicationsPage = (
			<box class="selector-page" orientation={VERTICAL}>
				<box class="selector-content" orientation={VERTICAL} vexpand>
					<entry
						class="selector-search"
						placeholderText="Search installed applications"
						primaryIconName="system-search-symbolic"
						text={applicationSearch}
						onNotifyText={(self) => updateApplicationQuery(self.text)}
					/>
					<box class="selector-results-surface" orientation={VERTICAL} vexpand>
						<Gtk.ScrolledWindow
							visible={hasApplicationOptions}
							vexpand
							hscrollbarPolicy={Gtk.PolicyType.NEVER}
						>
							<Gtk.GridView
								class="application-list"
								model={applicationSelection}
								factory={applicationFactory}
								minColumns={1}
								maxColumns={1}
								$={(self) => (applicationGrid = self)}
							/>
						</Gtk.ScrolledWindow>
						<Placeholder
							iconName={icons.ui.search}
							label="No results found"
							visible={showApplicationEmpty}
						/>
					</box>
				</box>
				<box class="selector-actions" orientation={HORIZONTAL} hexpand>
					<box hexpand />
					<button onClicked={openLocationSelector}>
						<box orientation={HORIZONTAL}>
							<image iconName="drive-harddisk-symbolic" />
							<label label="Choose Folder or Disk" />
						</box>
					</button>
					<button onClicked={selectAnotherApplication}>
						<box orientation={HORIZONTAL}>
							<image iconName="document-open-symbolic" />
							<label label="Choose Another Application" />
						</box>
					</button>
				</box>
			</box>
		)

		const locationsPage = (
			<box class="selector-page" orientation={VERTICAL}>
				<box class="selector-content" orientation={VERTICAL} vexpand>
					<box class="selector-results-surface" orientation={VERTICAL} vexpand>
						<Gtk.ScrolledWindow
							visible={hasVolumeOptions}
							vexpand
							hscrollbarPolicy={Gtk.PolicyType.NEVER}
						>
							<box class="location-list" orientation={VERTICAL}>
								<For each={volumeOptions}>
									{(option) => (
										<button
											class="location-option"
											sensitive={mountingVolume.as((key) => !key)}
											onClicked={() => selectVolume(option)}
										>
											<box orientation={HORIZONTAL}>
												<image gicon={option.icon} pixelSize={32} />
												<box
													class="option-copy"
													orientation={VERTICAL}
													valign={CENTER}
													hexpand
												>
													<label
														class="option-title"
														label={option.name}
														xalign={0}
														ellipsize={3}
													/>
													<label
														class="option-detail"
														label={mountingVolume.as((key) =>
															key === option.key
																? "Mounting..."
																: option.detail,
														)}
														xalign={0}
														ellipsize={3}
													/>
												</box>
												<image iconName="go-next-symbolic" />
											</box>
										</button>
									)}
								</For>
							</box>
						</Gtk.ScrolledWindow>
						<Placeholder
							iconName="drive-harddisk-symbolic"
							label="No disks or volumes found"
							visible={hasVolumeOptions.as((hasOptions) => !hasOptions)}
						/>
					</box>
					<label
						class="error"
						label={errorMessage}
						visible={errorMessage.as(Boolean)}
						xalign={0}
						wrap
					/>
				</box>
				<box class="selector-actions" orientation={HORIZONTAL} hexpand>
					<box hexpand />
					<button onClicked={selectFolderShortcut}>
						<box orientation={HORIZONTAL}>
							<image iconName="folder-open-symbolic" />
							<label label="Choose a Folder" />
						</box>
					</button>
				</box>
			</box>
		)

		const iconsPage = (
			<box class="selector-page" orientation={VERTICAL}>
				<box class="selector-content" orientation={VERTICAL} vexpand>
					<box class="icon-search-row" orientation={HORIZONTAL}>
						<entry
							class="selector-search"
							placeholderText="Search GTK icons"
							primaryIconName="system-search-symbolic"
							text={iconSearch}
							hexpand
							onNotifyText={(self) => updateIconQuery(self.text)}
						/>
					</box>
					<box class="selector-results-surface" orientation={VERTICAL} vexpand>
						<IconResultsGrid
							selection={iconBaseSelection}
							visible={iconResultsPage.as((current) => current === "all")}
							setGrid={(grid) => (iconBaseGrid = grid)}
						/>
						<IconResultsGrid
							selection={iconFilteredSelections[0]}
							visible={iconResultsPage.as(
								(current) => current === "filtered-a",
							)}
							setGrid={(grid) => (iconFilteredGrids[0] = grid)}
						/>
						<IconResultsGrid
							selection={iconFilteredSelections[1]}
							visible={iconResultsPage.as(
								(current) => current === "filtered-b",
							)}
							setGrid={(grid) => (iconFilteredGrids[1] = grid)}
						/>
						<Placeholder
							iconName={icons.ui.search}
							label="No results found"
							visible={iconResultsPage.as((current) => current === "empty")}
						/>
					</box>
				</box>
				<box class="selector-actions" orientation={HORIZONTAL} hexpand>
					<box hexpand />
					<button onClicked={selectImageIcon}>
						<box orientation={HORIZONTAL}>
							<image iconName="image-x-generic-symbolic" />
							<label label="Choose an Image" />
						</box>
					</button>
				</box>
			</box>
		)

		return (
			<Gtk.Window
				title="Create Launcher"
				name="desktop-launcher-creator"
				class="desktop-launcher-creator"
				application={app}
				defaultWidth={600}
				defaultHeight={640}
				heightRequest={640}
				hideOnClose
				iconName="application-x-executable-symbolic"
				$={(self) => {
					self.connect("hide", () => {
						creatorSession += 1
						setMountingVolume("")
					})
				}}
			>
				<box orientation={VERTICAL}>
					<centerbox class="header">
						<button
							$type="start"
							class="back"
							visible={page.as((current) => current !== "form")}
							onClicked={() => setPage("form")}
						>
							<image iconName="go-previous-symbolic" />
						</button>
						<label $type="center" class="title" label={headerTitle} />
						<button
							$type="end"
							class="close"
							onClicked={() =>
								app.get_window("desktop-launcher-creator")?.hide()
							}
						>
							<image iconName="window-close-symbolic" />
						</button>
					</centerbox>

					<Gtk.Stack
						transitionType={SLIDE_LEFT_RIGHT}
						visibleChildName={page}
						vhomogeneous={false}
						vexpand
					>
						<Gtk.StackPage name="form" child={formPage as Gtk.Widget} />
						<Gtk.StackPage
							name="applications"
							child={applicationsPage as Gtk.Widget}
						/>
						<Gtk.StackPage
							name="locations"
							child={locationsPage as Gtk.Widget}
						/>
						<Gtk.StackPage name="icons" child={iconsPage as Gtk.Widget} />
					</Gtk.Stack>
				</box>
			</Gtk.Window>
		)
	}
}

const { CENTER, FILL } = Gtk.Align
const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { SLIDE_LEFT_RIGHT } = Gtk.StackTransitionType

type CreatorPage = "form" | "applications" | "locations" | "icons"
type CreatorTarget = "custom" | "application" | "location"
type IconResultsPage = "all" | "filtered-a" | "filtered-b" | "empty"
type VolumeOption = {
	key: string
	volume: Gio.Volume
	name: string
	detail: string
	icon: Gio.Icon
	target: string
	canMount: boolean
}

const [targetMonitor, setTargetMonitor] = createState("")
const [name, setName] = createState("")
const [comment, setComment] = createState("")
const [command, setCommand] = createState("")
const [icon, setIcon] = createState("")
const [applicationLabel, setApplicationLabel] = createState("")
const [workingDirectory, setWorkingDirectory] = createState("")
const [terminal, setTerminal] = createState(false)
const [targetKind, setTargetKind] = createState<CreatorTarget>("custom")
const [errorMessage, setErrorMessage] = createState("")
const [page, setPage] = createState<CreatorPage>("form")
const [applicationSearch, setApplicationSearch] = createState("")
const [iconSearch, setIconSearch] = createState("")
let root: (() => void) | null = null
let creatorSession = 0

const imageFilter = (() => {
	const filter = new Gtk.FileFilter({ name: "Images" })
	filter.add_mime_type("image/*")
	return filter
})()

const applicationFilter = (() => {
	const filter = new Gtk.FileFilter({ name: "Applications" })
	filter.add_mime_type("application/x-executable")
	filter.add_mime_type("application/x-elf")
	filter.add_mime_type("application/vnd.appimage")
	filter.add_mime_type("application/x-shellscript")
	filter.add_mime_type("text/x-shellscript")
	return filter
})()

function ensureWindow() {
	const existing = app.get_window("desktop-launcher-creator")
	if (existing) return existing

	let window: Gtk.Window | null = null
	root ??= createRoot((dispose) => {
		window = DesktopLauncherCreator.Window() as Gtk.Window
		return dispose
	})
	return window
}

function reset() {
	setName("")
	setComment("")
	setCommand("")
	setIcon("")
	setApplicationLabel("")
	setWorkingDirectory("")
	setTerminal(false)
	setTargetKind("custom")
	setErrorMessage("")
	setPage("form")
	setApplicationSearch("")
	setIconSearch("")
}

function quoteExecArgument(value: string) {
	return `"${value
		.replace(/%/g, "%%")
		.replace(/[`"$\\]/g, (character) => `\\${character}`)}"`
}

function launcherIconName(icon: Gio.Icon, fallback: string) {
	if (icon instanceof Gio.ThemedIcon) return icon.get_names()[0] || fallback
	return icon.to_string() || fallback
}

function folderIconName(path: string) {
	const folders: Array<[string | null, string]> = [
		[
			GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP),
			"folder-desktop",
		],
		[
			GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS),
			"folder-documents",
		],
		[
			GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD),
			"folder-download",
		],
		[
			GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC),
			"folder-music",
		],
		[
			GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES),
			"folder-pictures",
		],
		[
			GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE),
			"folder-public",
		],
		[
			GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_TEMPLATES),
			"folder-templates",
		],
		[
			GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS),
			"folder-videos",
		],
		[GLib.get_home_dir(), "folder-home"],
	]
	const selected = Gio.File.new_for_path(path)
	return (
		folders.find(
			([folder]) => folder && selected.equal(Gio.File.new_for_path(folder)),
		)?.[1] ?? "folder"
	)
}

function commandTargetsDirectory(value: string) {
	try {
		const [parsed, argv] = GLib.shell_parse_argv(value.trim())
		if (!parsed || argv?.length !== 2 || argv[0] !== "xdg-open") return false
		const target = argv[1]
		const file = target.startsWith("file://")
			? Gio.File.new_for_uri(target)
			: GLib.path_is_absolute(target)
				? Gio.File.new_for_path(target)
				: null
		return (
			file?.query_file_type(Gio.FileQueryInfoFlags.NONE, null) ===
			Gio.FileType.DIRECTORY
		)
	} catch {
		return false
	}
}

function chooseFile(
	title: string,
	onSelected: (path: string) => void,
	filter?: Gtk.FileFilter,
) {
	const session = creatorSession
	const dialog = new Gtk.FileDialog({ title, modal: true })
	if (filter) {
		const filters = Gio.ListStore.new(Gtk.FileFilter.$gtype)
		filters.append(filter)
		dialog.set_filters(filters)
		dialog.set_default_filter(filter)
	}
	dialog.open(
		app.get_window("desktop-launcher-creator"),
		null,
		(_source, result) => {
			try {
				const path = dialog.open_finish(result)?.get_path()
				if (session === creatorSession && path) onSelected(path)
			} catch (error) {
				if (session !== creatorSession) return
				if (isDialogDismissed(error)) return
				console.error(`desktop.launcherChooser: ${title} failed`, error)
			}
		},
	)
}

function chooseDirectory(
	onSelected: (path: string) => void,
	title = "Choose working directory",
) {
	const session = creatorSession
	const dialog = new Gtk.FileDialog({ title, modal: true })
	dialog.select_folder(
		app.get_window("desktop-launcher-creator"),
		null,
		(_source, result) => {
			try {
				const path = dialog.select_folder_finish(result)?.get_path()
				if (session === creatorSession && path) onSelected(path)
			} catch (error) {
				if (session !== creatorSession) return
				if (isDialogDismissed(error)) return
				console.error(
					"desktop.launcherChooser: Directory selection failed",
					error,
				)
			}
		},
	)
}
