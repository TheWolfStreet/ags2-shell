import app from "$lib/app"
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
import { idle } from "$lib/time"

import AstalApps from "gi://AstalApps"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { applications } from "$service/apps"
import icons from "$lib/icons"
import { is_dialog_dismissed } from "$lib/ui"
import { ApplicationIcon } from "widget/shared/ApplicationIcon"
import { Placeholder } from "widget/shared/Placeholder"
import { create_desktop_entry, desktop_interaction } from "../Desktop"

export namespace DesktopLauncherCreator {
	export function open(monitor_id: string) {
		creator_session += 1
		reset()
		set_target_monitor(monitor_id)
		ensure_window()?.present()
	}

	export function Window() {
		const existing = app.get_window("desktop-launcher-creator")
		if (existing) return existing

		const create_blocked_reason = createComputed(() => {
			const missing_name = !name().trim()
			const missing_command = !command().trim()
			if (missing_name && missing_command)
				return "Enter a launcher name and command."
			if (missing_name) return "Enter a launcher name."
			if (missing_command) return "Enter a command or choose an application."
			return ""
		})
		const can_create = create_blocked_reason.as((reason) => !reason)
		const create_tooltip = create_blocked_reason.as(
			(reason) => reason || "Create the launcher on the desktop",
		)
		const volume_monitor = Gio.VolumeMonitor.get()
		const [volume_options, set_volume_options] = createState<volume_option[]>(
			[],
		)
		const [mounting_volume, set_mounting_volume] = createState("")
		function sync_volumes() {
			set_volume_options(
				volume_monitor
					.get_volumes()
					.map((volume) => {
						const mount = volume.get_mount()
						const root = mount?.get_root()
						const target = root?.get_path() ?? root?.get_uri() ?? ""
						const can_mount = volume.can_mount()
						return {
							key:
								volume.get_uuid() ??
								volume.get_identifier(Gio.VOLUME_IDENTIFIER_KIND_UNIX_DEVICE) ??
								volume.get_name(),
							volume,
							name: volume.get_name(),
							detail: target || (can_mount ? "Not mounted" : "Unavailable"),
							icon: volume.get_symbolic_icon(),
							target,
							can_mount,
						}
					})
					.filter((option) => option.target || option.can_mount)
					.sort((left, right) => left.name.localeCompare(right.name)),
			)
		}
		sync_volumes()
		const volume_handlers = [
			volume_monitor.connect("volume-added", sync_volumes),
			volume_monitor.connect("volume-removed", sync_volumes),
			volume_monitor.connect("volume-changed", sync_volumes),
			volume_monitor.connect("mount-added", sync_volumes),
			volume_monitor.connect("mount-removed", sync_volumes),
			volume_monitor.connect("mount-changed", sync_volumes),
		]
		onCleanup(() =>
			volume_handlers.forEach((handler) => volume_monitor.disconnect(handler)),
		)
		const all_applications = createBinding(applications, "list")
		const application_model = Gio.ListStore.new(AstalApps.Application.$gtype)
		let application_query = ""
		const application_search_index = new WeakMap<
			AstalApps.Application,
			string
		>()
		const catalog_sorter = Gtk.CustomSorter.new((left, right) => {
			const left_application = left as unknown as AstalApps.Application
			const right_application = right as unknown as AstalApps.Application

			const frequency_difference =
				right_application.get_frequency() - left_application.get_frequency()
			if (frequency_difference < 0) return Gtk.Ordering.SMALLER
			if (frequency_difference > 0) return Gtk.Ordering.LARGER
			const name_difference = left_application
				.get_name()
				.localeCompare(right_application.get_name())
			if (name_difference < 0) return Gtk.Ordering.SMALLER
			if (name_difference > 0) return Gtk.Ordering.LARGER
			return Gtk.Ordering.EQUAL
		})
		const sorted_applications = Gtk.SortListModel.new(
			application_model,
			catalog_sorter,
		)
		sorted_applications.set_incremental(true)
		const catalog_filter = Gtk.CustomFilter.new((item) => {
			if (!(item instanceof AstalApps.Application)) return false
			let searchable = application_search_index.get(item)
			if (searchable === undefined) {
				searchable = [
					item.get_name(),
					item.get_description(),
					item.get_executable(),
				]
					.filter(Boolean)
					.join("\n")
					.toLowerCase()
				application_search_index.set(item, searchable)
			}
			return !application_query || searchable.includes(application_query)
		})
		const filtered_applications = Gtk.FilterListModel.new(
			sorted_applications,
			catalog_filter,
		)
		filtered_applications.set_incremental(false)
		const application_selection = Gtk.NoSelection.new(filtered_applications)
		const application_factory = Gtk.SignalListItemFactory.new()
		const application_cells = new WeakMap<
			Gtk.ListItem,
			ReturnType<typeof create_application_cell>
		>()
		let application_grid: Gtk.GridView | null = null
		let application_open_pending = false

		function sync_applications() {
			application_model.splice(
				0,
				application_model.get_n_items(),
				all_applications.peek(),
			)
		}
		sync_applications()
		onCleanup(all_applications.subscribe(sync_applications))

		const display = Gdk.Display.get_default()
		const icon_names = display
			? Gtk.IconTheme.get_for_display(display).get_icon_names()
			: []
		const icon_model = Gtk.StringList.new(icon_names)
		const icon_expression = Gtk.PropertyExpression.new(
			Gtk.StringObject.$gtype,
			null,
			"string",
		)
		const icon_base_selection = Gtk.NoSelection.new(icon_model)
		const icon_filtered_selection = Gtk.NoSelection.new(null)
		const [icon_results_page, set_icon_results_page] =
			createState<icon_results_page>("all")
		const icon_factory = Gtk.SignalListItemFactory.new()
		const icon_cells = new WeakMap<
			Gtk.ListItem,
			{ image: Gtk.Image; label: Gtk.Label }
		>()
		let icon_base_grid: Gtk.GridView | null = null
		let icon_filtered_grid: Gtk.GridView | null = null
		let icon_query = ""
		let pending_icon_model: Gtk.FilterListModel | null = null
		let pending_icon_handler = 0

		icon_factory.connect("setup", (_factory, object) => {
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
			icon_cells.set(item, { image, label })
		})
		icon_factory.connect("bind", (_factory, object) => {
			const item = object as Gtk.ListItem
			const value = item.get_item()
			const cell = icon_cells.get(item)
			if (!(value instanceof Gtk.StringObject) || !cell) return
			const icon_name = value.get_string()
			cell.image.set_from_icon_name(icon_name)
			cell.label.set_label(icon_name)
			item.get_child()?.set_tooltip_text(icon_name)
		})

		function update_icon_query(value: string) {
			set_icon_search(value)
			const next_query = value.trim()
			if (next_query === icon_query) {
				reset_active_icon_anchor()
				return
			}
			icon_query = next_query
			cancel_pending_icon_filter()
			if (!next_query) {
				set_icon_results_page("all")
				icon_base_grid?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
				return
			}

			const filter = Gtk.StringFilter.new(icon_expression)
			filter.set_ignore_case(true)
			filter.set_match_mode(Gtk.StringFilterMatchMode.SUBSTRING)
			filter.set_search(next_query)
			const candidate = Gtk.FilterListModel.new(null, filter)
			candidate.set_incremental(true)
			pending_icon_model = candidate
			const finish = () => {
				if (pending_icon_model !== candidate || candidate.get_pending() > 0)
					return
				candidate.disconnect(pending_icon_handler)
				pending_icon_handler = 0
				pending_icon_model = null
				icon_filtered_selection.set_model(candidate)
				if (candidate.get_n_items() === 0) {
					set_icon_results_page("empty")
					return
				}
				icon_filtered_grid?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
				set_icon_results_page("filtered")
			}
			pending_icon_handler = candidate.connect("notify::pending", finish)
			candidate.set_model(icon_model)
			finish()
		}
		function cancel_pending_icon_filter() {
			if (!pending_icon_model) return
			if (pending_icon_handler)
				pending_icon_model.disconnect(pending_icon_handler)
			pending_icon_model.set_model(null)
			pending_icon_model = null
			pending_icon_handler = 0
		}
		function reset_active_icon_anchor() {
			const current = icon_results_page.peek()
			if (current === "all")
				icon_base_grid?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
			if (current === "filtered")
				icon_filtered_grid?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
		}
		function open_icon_selector() {
			application_open_pending = false
			update_icon_query("")
			set_page("icons")
		}
		onCleanup(cancel_pending_icon_filter)
		function update_application_query(value: string) {
			set_application_search(value)
			const next_query = value.trim().toLowerCase()
			if (next_query === application_query) {
				reset_application_anchor()
				return
			}
			application_query = next_query
			catalog_filter.changed(Gtk.FilterChange.DIFFERENT)
			reset_application_anchor()
		}
		function reset_application_anchor() {
			if (application_selection.get_n_items() > 0)
				application_grid?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
		}
		function open_application_selector() {
			cancel_pending_icon_filter()
			application_open_pending = true
			update_application_query("")
			finish_opening_application_selector()
		}
		function finish_opening_application_selector() {
			if (!application_open_pending) return
			idle(() => {
				if (
					!application_open_pending ||
					filtered_applications.get_pending() > 0 ||
					sorted_applications.get_pending() > 0
				)
					return
				reset_application_anchor()
				application_open_pending = false
				set_page("applications")
			})
		}
		function open_location_selector() {
			application_open_pending = false
			cancel_pending_icon_filter()
			sync_volumes()
			set_error_message("")
			set_page("locations")
		}
		const filter_pending_handler = filtered_applications.connect(
			"notify::pending",
			finish_opening_application_selector,
		)
		const sort_pending_handler = sorted_applications.connect(
			"notify::pending",
			finish_opening_application_selector,
		)
		onCleanup(() => {
			filtered_applications.disconnect(filter_pending_handler)
			sorted_applications.disconnect(sort_pending_handler)
		})
		const selected_application_name = application_label.as(
			(value) => value.trim() || "Choose",
		)
		const working_directory_label = working_directory.as(
			(path) => path.trim().split("/").pop() || "Choose",
		)
		const directory_target = createComputed(
			() =>
				target_kind() === "location" || command_targets_directory(command()),
		)
		const show_application_options = directory_target.as(
			(directory) => !directory,
		)
		const has_application_options = createBinding(
			filtered_applications,
			"nItems",
		).as(Boolean)
		const show_application_empty = has_application_options.as(
			(has_options) => !has_options,
		)
		const has_volume_options = volume_options.as(
			(options) => options.length > 0,
		)
		const header_title = page.as((current) => {
			if (current === "applications") return "Choose a Target"
			if (current === "locations") return "Choose a Folder or Disk"
			if (current === "icons") return "Choose an Icon"
			return "Create a Desktop Launcher"
		})

		function select_application(application: AstalApps.Application) {
			set_application_label(application.get_name())
			set_name(application.get_name())
			set_comment(application.get_description() || "")
			set_command(application.get_executable() || "")
			set_icon(application.get_icon_name() || "application-x-executable")
			set_working_directory(application.get_key("Path") || "")
			set_terminal(application.get_key("Terminal")?.toLowerCase() === "true")
			set_target_kind("application")
			set_page("form")
		}

		function create_application_cell() {
			return createRoot((dispose) => {
				const [cell_icon, set_cell_icon] = createState(
					"application-x-executable-symbolic",
				)
				let current_application: AstalApps.Application | null = null
				let title!: Gtk.Label
				let detail!: Gtk.Label
				const widget = (
					<button
						class="application-option"
						halign={FILL}
						hexpand
						onClicked={() => {
							if (current_application) select_application(current_application)
						}}
					>
						<box orientation={HORIZONTAL}>
							<ApplicationIcon icon={cell_icon} size={40} />
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
						current_application = application
						widget.remove_css_class("first")
						widget.remove_css_class("last")
						if (position === 0) widget.add_css_class("first")
						if (position === count - 1) widget.add_css_class("last")
						set_cell_icon(
							application.get_icon_name() ||
								"application-x-executable-symbolic",
						)
						title.set_label(application.get_name())
						detail.set_label(
							application.get_description() || application.get_executable(),
						)
					},
					clear() {
						current_application = null
					},
					dispose,
				}
			})
		}

		application_factory.connect("setup", (_factory, object) => {
			const item = object as Gtk.ListItem
			const cell = create_application_cell()
			item.set_activatable(false)
			item.set_selectable(false)
			item.set_child(cell.widget)
			application_cells.set(item, cell)
		})
		application_factory.connect("bind", (_factory, object) => {
			const item = object as Gtk.ListItem
			const application = item.get_item()
			const cell = application_cells.get(item)
			if (!(application instanceof AstalApps.Application) || !cell) return
			cell.bind(
				application,
				item.get_position(),
				application_selection.get_n_items(),
			)
		})
		application_factory.connect("unbind", (_factory, object) => {
			const item = object as Gtk.ListItem
			application_cells.get(item)?.clear()
		})
		application_factory.connect("teardown", (_factory, object) => {
			const item = object as Gtk.ListItem
			const cell = application_cells.get(item)
			if (!cell) return
			cell.dispose()
			item.set_child(null)
			application_cells.delete(item)
		})

		function IconResultsGrid({
			selection,
			visible,
			set_grid: set_grid,
		}: {
			selection: Gtk.NoSelection
			visible: Accessor<boolean>
			set_grid: (grid: Gtk.GridView) => void
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
						factory={icon_factory}
						minColumns={5}
						maxColumns={8}
						singleClickActivate
						$={(self) => {
							set_grid(self)
							self.connect("activate", (_grid, position) => {
								const value = selection.get_item(position)
								if (!(value instanceof Gtk.StringObject)) return
								set_icon(value.get_string())
								set_page("form")
							})
						}}
					/>
				</Gtk.ScrolledWindow>
			)
		}

		function select_another_application() {
			choose_file(
				"Choose application",
				(path) => {
					const base_name = path.split("/").pop() || "Application"
					set_application_label(base_name)
					if (!name.peek().trim()) set_name(base_name)
					set_command(quote_exec_argument(path))
					if (!icon.peek().trim()) set_icon("application-x-executable")
					set_target_kind("application")
					set_page("form")
				},
				application_filter,
			)
		}

		function select_location(name: string, target: string, icon_name: string) {
			set_application_label(name)
			set_name(name)
			set_comment(`Open ${name}`)
			set_command(`xdg-open ${quote_exec_argument(target)}`)
			set_icon(icon_name)
			set_target_kind("location")
			set_error_message("")
			set_page("form")
		}

		function select_volume(option: volume_option) {
			if (option.target) {
				select_location(
					option.name,
					option.target,
					launcher_icon_name(option.icon, "drive-harddisk-symbolic"),
				)
				return
			}
			if (!option.can_mount || mounting_volume.peek()) return

			set_mounting_volume(option.key)
			set_error_message("")
			const session = creator_session
			const parent = app.get_window("desktop-launcher-creator")
			if (!parent) {
				set_mounting_volume("")
				set_error_message("Launcher window is no longer available")
				return
			}
			try {
				const operation = Gtk.MountOperation.new(parent)
				option.volume.mount(
					Gio.MountMountFlags.NONE,
					operation,
					null,
					(_volume, result) => {
						try {
							if (!option.volume.mount_finish(result))
								throw new Error("Mount returned false")
							if (session !== creator_session) return
							const root = option.volume.get_mount()?.get_root()
							const target = root?.get_path() ?? root?.get_uri()
							if (!target)
								throw new Error("Mounted volume has no accessible location")
							select_location(
								option.name,
								target,
								launcher_icon_name(option.icon, "drive-harddisk-symbolic"),
							)
						} catch (error) {
							if (session !== creator_session) return
							set_error_message(`Could not mount ${option.name}. ${error}`)
						} finally {
							if (session === creator_session) {
								set_mounting_volume("")
								sync_volumes()
							}
						}
					},
				)
			} catch (error) {
				if (session !== creator_session) return
				set_mounting_volume("")
				set_error_message(`Could not mount ${option.name}. ${error}`)
			}
		}

		function select_folder_shortcut() {
			choose_directory((path) => {
				const mounted = volume_options
					.peek()
					.find((option) => option.target === path)
				const folder_name =
					path.replace(/\/+$/, "").split("/").pop() || "Filesystem"
				select_location(
					mounted?.name ?? folder_name,
					path,
					mounted
						? launcher_icon_name(mounted.icon, "drive-harddisk-symbolic")
						: folder_icon_name(path),
				)
			}, "Choose a folder or mounted disk")
		}

		function select_image_icon() {
			choose_file(
				"Choose launcher image",
				(path) => {
					set_icon(path)
					set_page("form")
				},
				image_filter,
			)
		}

		function create() {
			set_error_message("")
			const is_directory = directory_target.peek()
			const path = create_desktop_entry(target_monitor.peek(), {
				kind: "launcher",
				name: name.peek(),
				comment: comment.peek(),
				command: command.peek(),
				icon: icon.peek(),
				workingDirectory: is_directory ? "" : working_directory.peek(),
				terminal: is_directory ? false : terminal.peek(),
			})
			if (!path) {
				set_error_message(
					"Could not create the launcher. Check the selected application and try again.",
				)
				return
			}

			desktop_interaction.select([path])
			app.get_window("desktop-launcher-creator")?.hide()
			reset()
		}

		const form_page = (
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
									onClicked={open_icon_selector}
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
									onNotifyText={(self) => set_name(self.text)}
								/>
								<entry
									text={comment}
									placeholderText="Add a description"
									onNotifyText={(self) => set_comment(self.text)}
								/>
							</box>
						</box>

						<Gtk.Separator />
						<box class="application-row editor-row" orientation={HORIZONTAL}>
							<label label="Target" xalign={0} hexpand />
							<button
								class="application-picker"
								onClicked={open_application_selector}
							>
								<box orientation={HORIZONTAL}>
									<label label={selected_application_name} ellipsize={3} />
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
									const manually_edited = self.text !== command.peek()
									set_command(self.text)
									if (manually_edited) set_target_kind("custom")
								}}
							/>
						</box>

						<Gtk.Separator visible={show_application_options} />
						<box
							class="working-folder-row editor-row"
							orientation={HORIZONTAL}
							visible={show_application_options}
						>
							<label label="Working Directory" xalign={0} hexpand />
							<box class="folder-control" orientation={HORIZONTAL}>
								<button
									class="folder-picker"
									tooltipText={working_directory}
									onClicked={() => choose_directory(set_working_directory)}
								>
									<box orientation={HORIZONTAL}>
										<image iconName="folder-symbolic" />
										<label label={working_directory_label} ellipsize={3} />
									</box>
								</button>
								<button
									class="clear-folder"
									tooltipText="Use application default"
									visible={working_directory.as(Boolean)}
									onClicked={() => set_working_directory("")}
								>
									<image iconName="edit-clear-symbolic" />
								</button>
							</box>
						</box>

						<Gtk.Separator visible={show_application_options} />
						<box
							class="terminal-row editor-row"
							orientation={HORIZONTAL}
							visible={show_application_options}
						>
							<label label="Run in Terminal" xalign={0} hexpand />
							<switch
								active={terminal}
								valign={CENTER}
								onNotifyActive={(self) => set_terminal(self.active)}
							/>
						</box>
					</box>

					<label
						class="error"
						label={error_message}
						visible={error_message.as(Boolean)}
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
					<box tooltipText={create_tooltip}>
						<button
							class="suggested-action"
							label="Create Launcher"
							sensitive={can_create}
							onClicked={create}
						/>
					</box>
				</box>
			</box>
		)

		const applications_page = (
			<box class="selector-page" orientation={VERTICAL}>
				<box class="selector-content" orientation={VERTICAL} vexpand>
					<entry
						class="selector-search"
						placeholderText="Search installed applications"
						primaryIconName="system-search-symbolic"
						text={application_search}
						onNotifyText={(self) => update_application_query(self.text)}
					/>
					<box class="selector-results-surface" orientation={VERTICAL} vexpand>
						<Gtk.ScrolledWindow
							visible={has_application_options}
							vexpand
							hscrollbarPolicy={Gtk.PolicyType.NEVER}
						>
							<Gtk.GridView
								class="application-list"
								model={application_selection}
								factory={application_factory}
								minColumns={1}
								maxColumns={1}
								$={(self) => (application_grid = self)}
							/>
						</Gtk.ScrolledWindow>
						<Placeholder
							iconName={icons.ui.search}
							label="No results found"
							visible={show_application_empty}
						/>
					</box>
				</box>
				<box class="selector-actions" orientation={HORIZONTAL} hexpand>
					<box hexpand />
					<button onClicked={open_location_selector}>
						<box orientation={HORIZONTAL}>
							<image iconName="drive-harddisk-symbolic" />
							<label label="Choose Folder or Disk" />
						</box>
					</button>
					<button onClicked={select_another_application}>
						<box orientation={HORIZONTAL}>
							<image iconName="document-open-symbolic" />
							<label label="Choose Another Application" />
						</box>
					</button>
				</box>
			</box>
		)

		const locations_page = (
			<box class="selector-page" orientation={VERTICAL}>
				<box class="selector-content" orientation={VERTICAL} vexpand>
					<box class="selector-results-surface" orientation={VERTICAL} vexpand>
						<Gtk.ScrolledWindow
							visible={has_volume_options}
							vexpand
							hscrollbarPolicy={Gtk.PolicyType.NEVER}
						>
							<box class="location-list" orientation={VERTICAL}>
								<For each={volume_options}>
									{(option) => (
										<button
											class="location-option"
											sensitive={mounting_volume.as((key) => !key)}
											onClicked={() => select_volume(option)}
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
														label={mounting_volume.as((key) =>
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
							visible={has_volume_options.as((has_options) => !has_options)}
						/>
					</box>
					<label
						class="error"
						label={error_message}
						visible={error_message.as(Boolean)}
						xalign={0}
						wrap
					/>
				</box>
				<box class="selector-actions" orientation={HORIZONTAL} hexpand>
					<box hexpand />
					<button onClicked={select_folder_shortcut}>
						<box orientation={HORIZONTAL}>
							<image iconName="folder-open-symbolic" />
							<label label="Choose a Folder" />
						</box>
					</button>
				</box>
			</box>
		)

		const icons_page = (
			<box class="selector-page" orientation={VERTICAL}>
				<box class="selector-content" orientation={VERTICAL} vexpand>
					<box class="icon-search-row" orientation={HORIZONTAL}>
						<entry
							class="selector-search"
							placeholderText="Search GTK icons"
							primaryIconName="system-search-symbolic"
							text={icon_search}
							hexpand
							onNotifyText={(self) => update_icon_query(self.text)}
						/>
					</box>
					<box class="selector-results-surface" orientation={VERTICAL} vexpand>
						<IconResultsGrid
							selection={icon_base_selection}
							visible={icon_results_page.as((current) => current === "all")}
							set_grid={(grid) => (icon_base_grid = grid)}
						/>
						<IconResultsGrid
							selection={icon_filtered_selection}
							visible={icon_results_page.as(
								(current) => current === "filtered",
							)}
							set_grid={(grid) => (icon_filtered_grid = grid)}
						/>
						<Placeholder
							iconName={icons.ui.search}
							label="No results found"
							visible={icon_results_page.as((current) => current === "empty")}
						/>
					</box>
				</box>
				<box class="selector-actions" orientation={HORIZONTAL} hexpand>
					<box hexpand />
					<button onClicked={select_image_icon}>
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
						creator_session += 1
						set_mounting_volume("")
					})
				}}
			>
				<box orientation={VERTICAL}>
					<centerbox class="header">
						<button
							$type="start"
							class="back"
							visible={page.as((current) => current !== "form")}
							onClicked={() => set_page("form")}
						>
							<image iconName="go-previous-symbolic" />
						</button>
						<label $type="center" class="title" label={header_title} />
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
						<Gtk.StackPage name="form" child={form_page as Gtk.Widget} />
						<Gtk.StackPage
							name="applications"
							child={applications_page as Gtk.Widget}
						/>
						<Gtk.StackPage
							name="locations"
							child={locations_page as Gtk.Widget}
						/>
						<Gtk.StackPage name="icons" child={icons_page as Gtk.Widget} />
					</Gtk.Stack>
				</box>
			</Gtk.Window>
		)
	}
}

const { CENTER, FILL } = Gtk.Align
const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { SLIDE_LEFT_RIGHT } = Gtk.StackTransitionType

type creator_page = "form" | "applications" | "locations" | "icons"
type creator_target = "custom" | "application" | "location"
type icon_results_page = "all" | "filtered" | "empty"
type volume_option = {
	key: string
	volume: Gio.Volume
	name: string
	detail: string
	icon: Gio.Icon
	target: string
	can_mount: boolean
}

const [target_monitor, set_target_monitor] = createState("")
const [name, set_name] = createState("")
const [comment, set_comment] = createState("")
const [command, set_command] = createState("")
const [icon, set_icon] = createState("")
const [application_label, set_application_label] = createState("")
const [working_directory, set_working_directory] = createState("")
const [terminal, set_terminal] = createState(false)
const [target_kind, set_target_kind] = createState<creator_target>("custom")
const [error_message, set_error_message] = createState("")
const [page, set_page] = createState<creator_page>("form")
const [application_search, set_application_search] = createState("")
const [icon_search, set_icon_search] = createState("")
let root: (() => void) | null = null
let creator_session = 0

const image_filter = (() => {
	const filter = new Gtk.FileFilter({ name: "Images" })
	filter.add_mime_type("image/*")
	return filter
})()

const application_filter = (() => {
	const filter = new Gtk.FileFilter({ name: "Applications" })
	filter.add_mime_type("application/x-executable")
	filter.add_mime_type("application/x-elf")
	filter.add_mime_type("application/vnd.appimage")
	filter.add_mime_type("application/x-shellscript")
	filter.add_mime_type("text/x-shellscript")
	return filter
})()

function ensure_window() {
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
	set_name("")
	set_comment("")
	set_command("")
	set_icon("")
	set_application_label("")
	set_working_directory("")
	set_terminal(false)
	set_target_kind("custom")
	set_error_message("")
	set_page("form")
	set_application_search("")
	set_icon_search("")
}

function quote_exec_argument(value: string) {
	return `"${value
		.replace(/%/g, "%%")
		.replace(/[`"$\\]/g, (character) => `\\${character}`)}"`
}

function launcher_icon_name(icon: Gio.Icon, fallback: string) {
	if (icon instanceof Gio.ThemedIcon) return icon.get_names()[0] || fallback
	return icon.to_string() || fallback
}

function folder_icon_name(path: string) {
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

function command_targets_directory(value: string) {
	try {
		const [parsed, argv] = GLib.shell_parse_argv(value.trim())
		if (!parsed || argv?.length !== 2 || argv[0] !== "xdg-open") return false
		const target = argv[1]
		let file: Gio.File | null = null
		if (target.startsWith("file://")) file = Gio.File.new_for_uri(target)
		else if (GLib.path_is_absolute(target)) file = Gio.File.new_for_path(target)
		return (
			file?.query_file_type(Gio.FileQueryInfoFlags.NONE, null) ===
			Gio.FileType.DIRECTORY
		)
	} catch {
		return false
	}
}

function choose_file(
	title: string,
	on_selected: (path: string) => void,
	filter?: Gtk.FileFilter,
) {
	const session = creator_session
	const dialog = new Gtk.FileDialog({ title, modal: true })
	const parent = app.get_window("desktop-launcher-creator")
	if (!parent) return
	if (filter) {
		const filters = Gio.ListStore.new(Gtk.FileFilter.$gtype)
		filters.append(filter)
		dialog.set_filters(filters)
		dialog.set_default_filter(filter)
	}
	dialog.open(parent, null, (_source, result) => {
		try {
			const path = dialog.open_finish(result)?.get_path()
			if (session !== creator_session) return
			if (!path) {
				console.error(`desktop.launcherChooser: ${title} has no local path`)
				return
			}
			on_selected(path)
		} catch (error) {
			if (session !== creator_session) return
			if (is_dialog_dismissed(error)) return
			console.error(`desktop.launcherChooser: ${title} failed`, error)
		}
	})
}

function choose_directory(
	on_selected: (path: string) => void,
	title = "Choose working directory",
) {
	const session = creator_session
	const dialog = new Gtk.FileDialog({ title, modal: true })
	const parent = app.get_window("desktop-launcher-creator")
	if (!parent) return
	dialog.select_folder(parent, null, (_source, result) => {
		try {
			const path = dialog.select_folder_finish(result)?.get_path()
			if (session !== creator_session) return
			if (!path) {
				console.error("desktop.launcherChooser: Folder has no local path")
				return
			}
			on_selected(path)
		} catch (error) {
			if (session !== creator_session) return
			if (is_dialog_dismissed(error)) return
			console.error(
				"desktop.launcherChooser: Directory selection failed",
				error,
			)
		}
	})
}
