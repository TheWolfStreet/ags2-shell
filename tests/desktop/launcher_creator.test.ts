import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import * as result_module from "../../lib/result.ts"
import icons from "../../lib/icons.ts"
import { accessor, create_state, nodes, read, tick } from "../helpers.ts"

type node = {
	type: unknown
	props: Record<string, any>
	classes: Set<string>
	[key: string]: any
}

class emitter {
	declare handlers: Map<number, [string, (...args: any[]) => unknown]>
	declare next_id: number
	constructor() {
		this.handlers = new Map()
		this.next_id = 1
	}
	connect(signal: string, handler: (...args: any[]) => unknown) {
		const id = this.next_id++
		this.handlers.set(id, [signal, handler])
		return id
	}
	disconnect(id: number) {
		assert.ok(this.handlers.delete(id), `disconnect of unknown handler ${id}`)
	}
	emit(signal: string, ...args: unknown[]) {
		for (const [name, handler] of [...this.handlers.values()])
			if (name === signal) handler(this, ...args)
	}
	count(signal: string) {
		return [...this.handlers.values()].filter(([name]) => name === signal)
			.length
	}
}

type volume_spec = {
	name: string
	uuid?: string | null
	device?: string | null
	path?: string | null
	uri?: string | null
	can_mount?: boolean
	icon?: unknown
}

async function launcher_fixture() {
	const events: unknown[][] = []
	const idles: (() => void)[] = []
	const cleanups: (() => void)[] = []
	const debounced: { ms: number; call: () => void; pending: boolean }[] = []
	const directories = new Set<string>()
	const special_dirs = new Map<number, string | null>()
	const dialogs: any[] = []
	const created: unknown[][] = []
	let create_result: string | null = "/home/test/Desktop/App.desktop"
	let window: node | null = null
	let window_available = true
	let manual_queries = false
	const held_queries: (() => void)[] = []
	let icon_names: string[] = []
	let icon_pending = 0
	const app_pending = { filtered: 0, sorted: 0 }

	class themed_icon {
		declare names: string[]
		constructor(names: string[]) {
			this.names = names
		}
		get_names() {
			return this.names
		}
	}

	class fake_volume extends emitter {
		declare spec: volume_spec
		declare mounts: ((volume: unknown, response: unknown) => void)[]
		declare mount_outcome: boolean | "throw" | "finish_throw"
		constructor(spec: volume_spec) {
			super()
			this.spec = spec
			this.mounts = []
			this.mount_outcome = true
		}
		get_mount() {
			const { path, uri } = this.spec
			if (path === undefined && uri === undefined) return null
			return {
				get_root: () => ({
					get_path: () => path ?? null,
					get_uri: () => uri ?? null,
				}),
			}
		}
		can_mount() {
			return this.spec.can_mount ?? false
		}
		get_uuid() {
			return this.spec.uuid ?? null
		}
		get_identifier(kind) {
			assert.equal(kind, "unix-device")
			return this.spec.device ?? null
		}
		get_name() {
			return this.spec.name
		}
		get_symbolic_icon() {
			return this.spec.icon ?? new themed_icon(["drive-removable"])
		}
		mount(flags, operation, cancellable, callback) {
			assert.equal(flags, 0)
			assert.deepEqual(operation, { parent: window })
			assert.equal(cancellable, null)
			if (this.mount_outcome === "throw") throw new Error("mount refused")
			events.push(["mount", this.spec.name])
			this.mounts.push(callback)
		}
		mount_finish(response) {
			assert.equal(response, "response")
			if (this.mount_outcome === "finish_throw") throw new Error("mount failed")
			return this.mount_outcome
		}
	}

	const volume_monitor = Object.assign(new emitter(), {
		volumes: [] as fake_volume[],
		get_volumes() {
			return this.volumes
		},
	})

	class application {
		declare fields: Record<string, any>
		constructor(fields: Record<string, any>) {
			this.fields = fields
		}
		get_name() {
			return this.fields.name
		}
		get_description() {
			return this.fields.description ?? null
		}
		get_executable() {
			return this.fields.executable ?? null
		}
		get_icon_name() {
			return this.fields.icon ?? null
		}
		get_frequency() {
			return this.fields.frequency ?? 0
		}
		get_key(key) {
			return this.fields.keys?.[key] ?? null
		}
		static $gtype = "AstalApps.Application"
	}

	const app_subscribers = new Set<() => void>()
	const applications = { list: [] as application[] }

	class list_model extends emitter {
		declare items: unknown[]
		constructor(items: unknown[] = []) {
			super()
			this.items = items
		}
		get_n_items() {
			return this.items.length
		}
		get_item(index: number) {
			return this.items[index] ?? null
		}
		splice(position, removed, added) {
			this.items.splice(position, removed, ...added)
		}
		append(item) {
			this.items.push(item)
		}
	}

	class string_object {
		declare value: string
		constructor(value: string) {
			this.value = value
		}
		get_string() {
			return this.value
		}
		static $gtype = "GtkStringObject"
	}

	const catalog: {
		sorter?: (left, right) => number
		filter?: (item) => boolean
		filter_changes: number
		filtered?: any
		sorted?: any
		application_factory?: emitter
		icon_factory?: emitter
		icon_candidates: any[]
		icon_filtered_selection?: any
	} = { filter_changes: 0, icon_candidates: [] }

	function make(type, props: Record<string, any> = {}): node {
		if (typeof type === "function") return type(props)
		const tree: node = {
			type,
			props,
			classes: new Set(
				String(props.class ?? "")
					.split(" ")
					.filter(Boolean),
			),
			add_css_class(name) {
				tree.classes.add(name)
			},
			remove_css_class(name) {
				tree.classes.delete(name)
			},
			set_label(label) {
				tree.label = label
			},
			present: () => events.push(["present"]),
			hide: () => {
				events.push(["hide"])
				for (const handler of tree.hide_handlers) handler()
			},
			hide_handlers: [] as (() => void)[],
			connect(signal, handler) {
				if (signal === "hide") tree.hide_handlers.push(handler)
				if (signal === "activate") tree.activate = handler
				return 1
			},
			scroll_to: (position, flags, scroll) => {
				assert.deepEqual([position, flags, scroll], [0, 0, null])
				events.push(["scroll", props.class])
			},
		}
		if (type === "Window") window = tree
		props.$?.(tree)
		return tree
	}

	const gtk = {
		Align: { CENTER: 3, FILL: 0 },
		Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
		StackTransitionType: { SLIDE_LEFT_RIGHT: 4 },
		PolicyType: { NEVER: 2 },
		ListScrollFlags: { NONE: 0 },
		FilterChange: { DIFFERENT: 0 },
		Ordering: { SMALLER: -1, EQUAL: 0, LARGER: 1 },
		StringFilterMatchMode: { SUBSTRING: 1 },
		Window: "Window",
		ScrolledWindow: "scrolled",
		GridView: "grid",
		AspectFrame: "aspect",
		Separator: "separator",
		Stack: "stack",
		StackPage: "page",
		StringObject: string_object,
		Image: class {
			declare options: Record<string, unknown>
			declare icon: string
			constructor(options) {
				this.options = options
			}
			set_from_icon_name(name) {
				this.icon = name
			}
		},
		Label: class {
			declare options: Record<string, unknown>
			declare label: string
			constructor(options) {
				this.options = options
			}
			set_label(label) {
				this.label = label
			}
		},
		Box: class {
			declare options: Record<string, unknown>
			declare calls: unknown[][]
			constructor(options) {
				this.options = options
				this.calls = []
			}
			add_css_class(name) {
				this.calls.push(["class", name])
			}
			set_halign(value) {
				this.calls.push(["halign", value])
			}
			set_valign(value) {
				this.calls.push(["valign", value])
			}
			append(child) {
				this.calls.push(["append", child.constructor.name, child])
			}
			set_tooltip_text(text) {
				this.calls.push(["tooltip", text])
			}
		},
		FileFilter: class {
			declare name: string
			declare mime_types: string[]
			constructor({ name }) {
				this.name = name
				this.mime_types = []
			}
			add_mime_type(mime) {
				this.mime_types.push(mime)
			}
			static $gtype = "GtkFileFilter"
		},
		FileDialog: class {
			declare options: Record<string, unknown>
			declare filters: unknown
			declare default_filter: unknown
			declare call: [string, unknown, unknown, (...args) => void] | null
			declare outcome: unknown
			constructor(options) {
				this.options = options
				this.call = null
				dialogs.push(this)
			}
			set_filters(filters) {
				this.filters = filters
			}
			set_default_filter(filter) {
				this.default_filter = filter
			}
			select_folder(parent, cancellable, finish) {
				this.call = ["folder", parent, cancellable, finish]
			}
			open(parent, cancellable, finish) {
				this.call = ["file", parent, cancellable, finish]
			}
			select_folder_finish(response) {
				return this.finish(response, "folder")
			}
			open_finish(response) {
				return this.finish(response, "file")
			}
			finish(response, kind) {
				assert.equal(response, "dialog-response")
				assert.equal(this.call?.[0], kind)
				if (this.outcome instanceof Error) throw this.outcome
				if (this.outcome === null) return null
				return { get_path: () => this.outcome }
			}
			respond(outcome) {
				this.outcome = outcome
				this.call![3](this, "dialog-response")
			}
		},
		MountOperation: { new: (parent) => ({ parent }) },
		CustomSorter: {
			new: (fn) => {
				catalog.sorter = fn
				return {}
			},
		},
		SortListModel: {
			new: (model, sorter) => {
				const sorted = Object.assign(new emitter(), {
					model,
					sorter,
					set_incremental: (value) =>
						events.push(["sorted_incremental", value]),
					get_pending: () => app_pending.sorted,
				})
				catalog.sorted = sorted
				return sorted
			},
		},
		CustomFilter: {
			new: (fn) => {
				catalog.filter = fn
				return {
					changed: (change) => {
						assert.equal(change, 0)
						catalog.filter_changes++
					},
				}
			},
		},
		FilterListModel: {
			new: (model, filter) => {
				const filtered: any = Object.assign(new emitter(), {
					model,
					filter,
					incremental: null,
					set_incremental(value) {
						filtered.incremental = value
					},
					set_model(next) {
						filtered.model = next
					},
					get_pending: () =>
						filter.search === undefined ? app_pending.filtered : icon_pending,
					get_n_items() {
						if (filter.search === undefined) return applications_shown()
						if (!filtered.model) return 0
						return filtered.model.items.filter((value) =>
							value.toLowerCase().includes(filter.search.toLowerCase()),
						).length
					},
				})
				Object.defineProperty(filtered, "nItems", {
					get: () => filtered.get_n_items(),
				})
				if (filter.search === undefined) catalog.filtered = filtered
				else catalog.icon_candidates.push(filtered)
				return filtered
			},
		},
		NoSelection: {
			new: (model) => {
				const selection: any = {
					model,
					set_model(next) {
						selection.model = next
					},
					get_n_items: () => selection.model?.get_n_items() ?? 0,
					get_item: (position) =>
						new string_object(selection.model.items[position]),
				}
				if (model === null) catalog.icon_filtered_selection = selection
				return selection
			},
		},
		SignalListItemFactory: {
			new: () => {
				const factory = new emitter()
				if (!catalog.application_factory) catalog.application_factory = factory
				else catalog.icon_factory = factory
				return factory
			},
		},
		IconTheme: {
			get_for_display: () => ({ get_icon_names: () => icon_names }),
		},
		StringList: { new: (names) => new list_model(names) },
		PropertyExpression: { new: () => ({}) },
		StringFilter: {
			new: () => {
				const filter: Record<string, unknown> = {}
				return Object.assign(filter, {
					set_ignore_case: (value) => (filter.ignore_case = value),
					set_match_mode: (value) => (filter.match_mode = value),
					set_search: (value) => (filter.search = value),
				})
			},
		},
	}

	function applications_shown() {
		return catalog.filtered.model.model.items.filter(catalog.filter).length
	}

	const gio = {
		VolumeMonitor: { get: () => volume_monitor },
		VOLUME_IDENTIFIER_KIND_UNIX_DEVICE: "unix-device",
		ListStore: { new: () => new list_model() },
		Cancellable: class {
			declare cancelled: boolean
			constructor() {
				this.cancelled = false
			}
			cancel() {
				this.cancelled = true
			}
		},
		ThemedIcon: themed_icon,
		MountMountFlags: { NONE: 0 },
		FileQueryInfoFlags: { NONE: 0 },
		FileType: { DIRECTORY: "directory" },
		File: {
			new_for_path: (path) => fake_file(path),
			new_for_uri: (uri) =>
				fake_file(decodeURIComponent(new URL(uri).pathname)),
		},
	}

	function fake_file(path: string) {
		return {
			path,
			equal: (other) => other.path === path,
			query_info_async(attributes, flags, priority, cancellable, callback) {
				assert.deepEqual(
					[attributes, flags, priority],
					["standard::type", 0, 0],
				)
				events.push([
					"query",
					path,
					cancellable === null ? "none" : "cancellable",
				])
				const respond = () => callback(null, "query-response")
				if (manual_queries) held_queries.push(respond)
				else queueMicrotask(respond)
			},
			query_info_finish(response) {
				assert.equal(response, "query-response")
				if (path.includes("missing")) throw new Error("missing")
				return {
					get_file_type: () =>
						directories.has(path) ? "directory" : "regular",
				}
			},
		}
	}

	function shell_parse_argv(value: string) {
		if (!value) throw new Error("empty")
		if (value.includes("'")) throw new Error("unbalanced")
		const argv: string[] = []
		for (const match of value.matchAll(/"((?:\\.|[^"])*)"|(\S+)/g))
			argv.push(
				match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2],
			)
		return [true, argv]
	}

	const imports = {
		"$lib/app": {
			default: {
				get_window: (name) => {
					assert.equal(name, "desktop-launcher-creator")
					return window_available ? window : null
				},
			},
		},
		ags: {
			createBinding: (object, property) => {
				if (object === applications)
					return accessor(
						() => applications.list,
						(callback) => {
							app_subscribers.add(callback)
							return () => app_subscribers.delete(callback)
						},
					)
				return accessor(() => object[property])
			},
			createComputed: (fn) => accessor(fn),
			createRoot: (fn) => fn(() => events.push(["dispose"])),
			createState: create_state,
			For: (props) => make("for", props),
			onCleanup: (fn) => cleanups.push(fn),
		},
		"ags/gtk4": {
			Gdk: { Display: { get_default: () => ({}) } },
			Gtk: gtk,
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"$lib/time": {
			debounce: (ms, fn) => {
				const entry = {
					ms,
					pending: false,
					call: () => {
						entry.pending = false
						fn()
					},
				}
				debounced.push(entry)
				return {
					call: () => {
						entry.pending = true
					},
					cancel: () => {
						entry.pending = false
					},
				}
			},
			idle: (run) => idles.push(run),
		},
		"gi://AstalApps": { default: { Application: application } },
		"gi://Gio": { default: gio },
		"gi://GLib": {
			default: {
				PRIORITY_DEFAULT: 0,
				UserDirectory: {
					DIRECTORY_DESKTOP: 0,
					DIRECTORY_DOCUMENTS: 1,
					DIRECTORY_DOWNLOAD: 2,
					DIRECTORY_MUSIC: 3,
					DIRECTORY_PICTURES: 4,
					DIRECTORY_PUBLIC_SHARE: 5,
					DIRECTORY_TEMPLATES: 6,
					DIRECTORY_VIDEOS: 7,
				},
				get_user_special_dir: (kind) => special_dirs.get(kind) ?? null,
				get_home_dir: () => "/home/test",
				path_is_absolute: (path) => path.startsWith("/"),
				shell_parse_argv,
			},
		},
		"gi://Pango": { default: { EllipsizeMode: { END: 3 } } },
		"$service/apps": { applications },
		"$lib/result": result_module,
		"$lib/icons": { default: icons },
		"$lib/ui": {
			is_dialog_dismissed: (error) => error?.code === "DISMISSED",
		},
		"widget/shared/ApplicationIcon": {
			ApplicationIcon: (props) => make("app_icon", props),
		},
		"widget/shared/Placeholder": {
			Placeholder: (props) => make("placeholder", props),
		},
		"../desktop": {
			create_desktop_entry: (monitor_id, spec) => {
				created.push([monitor_id, spec])
				return create_result
			},
			desktop_interaction: {
				select: (paths) => events.push(["select", paths]),
			},
		},
	}

	const { DesktopLauncherCreator } = await load_module(
		"widget/Desktop/components/LauncherCreator.tsx",
		{
			...imports,
			"widget/shared/IconPicker": await load_module(
				"widget/shared/IconPicker.tsx",
				imports,
			),
		},
	)

	const tree = () => {
		assert.ok(window)
		return window
	}
	const page_named = (name: string) =>
		nodes(tree()).find(
			(item) => item.type === "page" && item.props.name === name,
		).props.child
	const stack = () => nodes(tree(), "stack")[0]
	const current_page = () => read(stack().props.visibleChildName)
	const form = () => page_named("form")
	const entries = () => nodes(form(), "entry")
	const field = (placeholder: string) =>
		entries().find((item) => item.props.placeholderText === placeholder)!
	const by_class = (root: node, name: string) =>
		nodes(root).filter((item) => item.classes.has(name))
	const button_with_label = (root: node, label: string) =>
		nodes(root).find(
			(item) =>
				item.type === "button" &&
				(item.props.label === label ||
					nodes(item).some((inner) => inner.props.label === label)),
		)
	const location_rows = () => {
		const list = nodes(page_named("locations"), "for")[0]
		return read(list.props.each).map((option) => list.props.children(option))
	}
	const state = () => ({
		name: read(field("New Launcher").props.text),
		comment: read(field("Add a description").props.text),
		command: read(field("application --option").props.text),
		icon: read(nodes(form(), "app_icon")[0].props.icon),
		target: read(
			nodes(by_class(form(), "application-picker")[0], "label")[0].props.label,
		),
		working_directory: read(
			by_class(form(), "folder-picker")[0].props.tooltipText,
		),
		terminal: read(nodes(form(), "switch")[0].props.active),
		application_options: read(
			by_class(form(), "terminal-row")[0].props.visible,
		),
		error: read(by_class(form(), "error")[0].props.label),
		page: current_page(),
	})

	return {
		DesktopLauncherCreator,
		events,
		idles,
		cleanups,
		debounced,
		directories,
		special_dirs,
		dialogs,
		created,
		catalog,
		volume_monitor,
		applications,
		app_pending,
		themed_icon,
		string_object,
		fake_volume,
		application,
		tree,
		page_named,
		current_page,
		field,
		by_class,
		button_with_label,
		location_rows,
		state,
		add_volume: (spec: volume_spec) => {
			const volume = new fake_volume(spec)
			volume_monitor.volumes.push(volume)
			return volume
		},
		set_create_result: (value: string | null) => {
			create_result = value
		},
		held_queries,
		hold_queries: () => {
			manual_queries = true
		},
		set_window_available: (value: boolean) => {
			window_available = value
		},
		set_icon_names: (names: string[]) => {
			icon_names = names
		},
		set_icon_pending: (value: number) => {
			icon_pending = value
		},
		publish_applications: (list: application[]) => {
			applications.list = list
			for (const subscriber of [...app_subscribers]) subscriber()
		},
		flush_command_check: async () => {
			for (const entry of debounced) if (entry.pending) entry.call()
			await tick()
		},
		run_idles: () => {
			const pending = idles.splice(0)
			for (const run of pending) run()
		},
	}
}

function errors_of(t) {
	const logged: unknown[][] = []
	t.mock.method(console, "error", (...args) => {
		if (String(args[0]).startsWith("desktop."))
			logged.push(args.map((arg) => (arg instanceof Error ? arg.message : arg)))
	})
	return logged
}

const blank_form = {
	name: "",
	comment: "",
	command: "",
	icon: icons.fallback.app,
	target: "Choose",
	working_directory: "",
	terminal: false,
	application_options: true,
	error: "",
	page: "form",
}

test("open builds the window once, resets the form and presents it", async () => {
	const fixture = await launcher_fixture()
	fixture.DesktopLauncherCreator.open("monitor:a")
	assert.deepEqual(fixture.state(), blank_form)
	fixture.field("New Launcher").props.onNotifyText({ text: "Typed" })
	const first = fixture.tree()
	fixture.DesktopLauncherCreator.open("monitor:b")
	assert.equal(fixture.tree(), first)
	assert.deepEqual(fixture.state(), blank_form)
	assert.equal(
		fixture.events.filter((event) => event[0] === "present").length,
		2,
	)
	assert.equal(first.props.name, "desktop-launcher-creator")
})

test("the header follows the page and its buttons go back or hide", async () => {
	const fixture = await launcher_fixture()
	fixture.DesktopLauncherCreator.open("m")
	const header = fixture.by_class(fixture.tree(), "header")[0]
	const title = () =>
		read(nodes(header).find((item) => item.classes.has("title")).props.label)
	const back = fixture.by_class(header, "back")[0]
	const titles = [title()]
	fixture
		.by_class(fixture.page_named("form"), "application-picker")[0]
		.props.onClicked()
	fixture.run_idles()
	titles.push(title())
	fixture
		.button_with_label(
			fixture.page_named("applications"),
			"Choose Folder or Disk",
		)
		.props.onClicked()
	titles.push(title())
	fixture
		.by_class(fixture.page_named("form"), "icon-editor")[0]
		.props.onClicked()
	titles.push(title())
	assert.deepEqual(titles, [
		"Create a Desktop Launcher",
		"Choose a Target",
		"Choose a Folder or Disk",
		"Choose an Icon",
	])
	assert.equal(read(back.props.visible), true)
	back.props.onClicked()
	assert.equal(fixture.current_page(), "form")
	assert.equal(read(back.props.visible), false)
	fixture.by_class(header, "close")[0].props.onClicked()
	fixture
		.button_with_label(fixture.page_named("form"), "Cancel")
		.props.onClicked()
	assert.deepEqual(
		fixture.events.filter((event) => event[0] === "hide"),
		[["hide"], ["hide"]],
	)
})

test("volumes list mounted or mountable entries by name and resync on monitor signals", async () => {
	const fixture = await launcher_fixture()
	fixture.add_volume({ name: "Zeta", uuid: "z-uuid", path: "/run/media/zeta" })
	fixture.add_volume({ name: "Alpha", device: "/dev/sdb1", can_mount: true })
	fixture.add_volume({ name: "Web", uri: "smb://host/share" })
	fixture.add_volume({ name: "Gone" })
	fixture.DesktopLauncherCreator.open("m")
	const rows = () =>
		fixture.location_rows().map((row) => {
			const labels = nodes(row, "label")
			return [read(labels[0].props.label), read(labels[1].props.label)]
		})
	assert.deepEqual(rows(), [
		["Alpha", "Not mounted"],
		["Web", "smb://host/share"],
		["Zeta", "/run/media/zeta"],
	])
	const signals = [
		"volume-added",
		"volume-removed",
		"volume-changed",
		"mount-added",
		"mount-removed",
		"mount-changed",
	]
	assert.deepEqual(
		signals.map((signal) => fixture.volume_monitor.count(signal)),
		[1, 1, 1, 1, 1, 1],
	)
	for (const signal of signals) {
		fixture.add_volume({ name: signal, path: `/m/${signal}` })
		fixture.volume_monitor.emit(signal)
	}
	assert.equal(rows().length, 9)
	const empty = fixture.by_class(
		fixture.page_named("locations"),
		"location-list",
	)
	assert.equal(empty.length, 1)
	for (const cleanup of fixture.cleanups) cleanup()
	assert.deepEqual(
		signals.map((signal) => fixture.volume_monitor.count(signal)),
		[0, 0, 0, 0, 0, 0],
	)
})

test("an empty volume list shows the placeholder", async () => {
	const fixture = await launcher_fixture()
	fixture.DesktopLauncherCreator.open("m")
	const placeholder = nodes(fixture.page_named("locations"), "placeholder")[0]
	assert.equal(read(placeholder.props.visible), true)
	fixture.add_volume({ name: "Disk", path: "/d" })
	fixture.volume_monitor.emit("volume-added")
	assert.equal(read(placeholder.props.visible), false)
})

test("choosing a mounted volume fills the form as a location launcher", async () => {
	const fixture = await launcher_fixture()
	fixture.add_volume({
		name: "My $Disk",
		path: '/run/media/a"b%c',
		icon: new fixture.themed_icon(["drive-usb", "drive"]),
	})
	fixture.add_volume({
		name: "Plain",
		path: "/p",
		icon: { to_string: () => "" },
	})
	fixture.add_volume({
		name: "Stringy",
		path: "/s",
		icon: { to_string: () => ". GThemedIcon x" },
	})
	fixture.add_volume({
		name: "Unnamed",
		path: "/u",
		icon: new fixture.themed_icon([]),
	})
	fixture.DesktopLauncherCreator.open("m")
	const choose = (index: number) =>
		fixture.location_rows()[index].props.onClicked()
	choose(0)
	assert.deepEqual(fixture.state(), {
		...blank_form,
		name: "My $Disk",
		comment: "Open My $Disk",
		command: 'xdg-open "/run/media/a\\"b%%c"',
		icon: "drive-usb",
		target: "My $Disk",
		application_options: false,
	})
	const icons_of = [1, 2, 3].map((index) => {
		choose(index)
		return fixture.state().icon
	})
	assert.deepEqual(icons_of, [
		icons.fallback.drive,
		". GThemedIcon x",
		icons.fallback.drive,
	])
})

test("mounting a volume selects its location once mounted", async () => {
	const fixture = await launcher_fixture()
	const volume = fixture.add_volume({
		name: "USB",
		can_mount: true,
		uuid: "usb",
	})
	fixture.add_volume({ name: "Other", can_mount: true, uuid: "other" })
	fixture.DesktopLauncherCreator.open("m")
	fixture
		.button_with_label(
			fixture.page_named("applications"),
			"Choose Folder or Disk",
		)
		.props.onClicked()
	const row = () => fixture.location_rows()[1]
	const detail = () => read(nodes(row(), "label")[1].props.label)
	row().props.onClicked()
	assert.deepEqual(
		fixture.events.filter((event) => event[0] === "mount"),
		[["mount", "USB"]],
	)
	assert.equal(detail(), "Mounting...")
	assert.equal(read(row().props.sensitive), false)
	fixture.location_rows()[0].props.onClicked()
	assert.equal(fixture.events.filter((event) => event[0] === "mount").length, 1)

	volume.spec.path = "/run/media/usb"
	volume.mounts[0](volume, "response")
	assert.equal(detail(), "/run/media/usb")
	assert.equal(read(row().props.sensitive), true)
	assert.deepEqual(fixture.state(), {
		...blank_form,
		name: "USB",
		comment: "Open USB",
		command: 'xdg-open "/run/media/usb"',
		icon: "drive-removable",
		target: "USB",
		application_options: false,
	})
})

test("mount failures explain themselves and release the volume", async () => {
	const fixture = await launcher_fixture()
	const volume = fixture.add_volume({ name: "USB", can_mount: true })
	fixture.DesktopLauncherCreator.open("m")
	fixture
		.button_with_label(
			fixture.page_named("applications"),
			"Choose Folder or Disk",
		)
		.props.onClicked()
	const error = () =>
		read(
			fixture.by_class(fixture.page_named("locations"), "error")[0].props.label,
		)
	const sensitive = () => read(fixture.location_rows()[0].props.sensitive)
	const click = () => fixture.location_rows()[0].props.onClicked()

	volume.mount_outcome = "throw"
	click()
	assert.equal(error(), "Could not mount USB. Error: mount refused")
	assert.equal(sensitive(), true)

	volume.mount_outcome = false
	click()
	assert.equal(error(), "")
	volume.mounts.shift()!(volume, "response")
	assert.equal(error(), "Could not mount USB. Error: Mount returned false")
	assert.equal(sensitive(), true)

	volume.mount_outcome = "finish_throw"
	click()
	volume.mounts.shift()!(volume, "response")
	assert.equal(error(), "Could not mount USB. Error: mount failed")

	volume.mount_outcome = true
	click()
	volume.mounts.shift()!(volume, "response")
	assert.equal(
		error(),
		"Could not mount USB. Error: Mounted volume has no accessible location",
	)
	assert.equal(fixture.current_page(), "locations")

	fixture.set_window_available(false)
	click()
	assert.equal(error(), "Launcher window is no longer available")
	assert.equal(sensitive(), true)
})

test("a mount that finishes after the window hid changes nothing", async () => {
	const fixture = await launcher_fixture()
	const volume = fixture.add_volume({ name: "USB", can_mount: true })
	const unmountable = fixture.add_volume({ name: "Dead" })
	unmountable.spec.can_mount = false
	fixture.DesktopLauncherCreator.open("m")
	fixture
		.button_with_label(
			fixture.page_named("applications"),
			"Choose Folder or Disk",
		)
		.props.onClicked()
	fixture.location_rows()[0].props.onClicked()
	fixture.tree().hide()
	assert.equal(read(fixture.location_rows()[0].props.sensitive), true)
	volume.spec.path = "/run/media/usb"
	volume.mounts[0](volume, "response")
	assert.equal(fixture.current_page(), "locations")
	assert.equal(fixture.state().name, "")
})

test("folder shortcuts reuse volume names and special folder icons", async () => {
	const fixture = await launcher_fixture()
	fixture.add_volume({ name: "Backup", path: "/run/media/backup" })
	fixture.special_dirs.set(1, "/home/test/Documents")
	fixture.special_dirs.set(7, "/home/test/Videos")
	fixture.DesktopLauncherCreator.open("m")
	const choose = (path: string) => {
		fixture
			.button_with_label(fixture.page_named("locations"), "Choose a Folder")
			.props.onClicked()
		const dialog = fixture.dialogs.at(-1)
		assert.deepEqual(dialog.options, {
			title: "Choose a folder or mounted disk",
			modal: true,
		})
		assert.equal(dialog.call[0], "folder")
		assert.equal(dialog.call[1], fixture.tree())
		assert.equal(dialog.filters, undefined)
		dialog.respond(path)
		const state = fixture.state()
		return [state.name, state.icon, state.command]
	}
	assert.deepEqual(
		[
			choose("/run/media/backup"),
			choose("/home/test/Documents"),
			choose("/home/test/Videos"),
			choose("/home/test"),
			choose("/srv/data//"),
			choose("/"),
		],
		[
			["Backup", "drive-removable", 'xdg-open "/run/media/backup"'],
			["Documents", "folder-documents", 'xdg-open "/home/test/Documents"'],
			["Videos", "folder-videos", 'xdg-open "/home/test/Videos"'],
			["test", "folder-home", 'xdg-open "/home/test"'],
			["data", "folder", 'xdg-open "/srv/data//"'],
			["Filesystem", "folder", 'xdg-open "/"'],
		],
	)
})

test("file choosers log failures, ignore dismissals and stale sessions", async (t) => {
	const fixture = await launcher_fixture()
	const logged = errors_of(t)
	fixture.DesktopLauncherCreator.open("m")
	const icons_page = fixture.page_named("icons")
	const choose_image = () =>
		fixture.button_with_label(icons_page, "Choose an Image").props.onClicked()

	choose_image()
	const image_dialog = fixture.dialogs.at(-1)
	assert.equal(image_dialog.call[0], "file")
	assert.equal(image_dialog.default_filter.name, "Images")
	assert.deepEqual(image_dialog.default_filter.mime_types, ["image/*"])
	assert.deepEqual(image_dialog.filters.items, [image_dialog.default_filter])
	image_dialog.respond(
		Object.assign(new Error("dismissed"), { code: "DISMISSED" }),
	)
	choose_image()
	fixture.dialogs.at(-1).respond(new Error("portal broke"))
	choose_image()
	fixture.dialogs.at(-1).respond(null)
	assert.deepEqual(logged, [
		["desktop.launcher_chooser: Choose launcher image failed", "portal broke"],
		["desktop.launcher_chooser: Choose launcher image has no local path"],
	])

	choose_image()
	const stale = fixture.dialogs.at(-1)
	fixture.tree().hide()
	stale.respond("/img/late.png")
	assert.equal(fixture.state().icon, icons.fallback.app)

	fixture.DesktopLauncherCreator.open("m")
	fixture
		.by_class(fixture.page_named("form"), "icon-editor")[0]
		.props.onClicked()
	choose_image()
	fixture.dialogs.at(-1).respond("/img/icon.png")
	assert.equal(fixture.state().icon, "/img/icon.png")
	assert.equal(fixture.current_page(), "form")

	fixture.set_window_available(false)
	const before = fixture.dialogs.length
	choose_image()
	assert.equal(fixture.dialogs.length, before + 1)
	assert.equal(fixture.dialogs.at(-1).call, null)
	assert.equal(logged.length, 2)
})

test("choosing another application quotes it and fills only empty fields", async () => {
	const fixture = await launcher_fixture()
	fixture.DesktopLauncherCreator.open("m")
	const choose = (path: string) => {
		fixture
			.button_with_label(
				fixture.page_named("applications"),
				"Choose Another Application",
			)
			.props.onClicked()
		const dialog = fixture.dialogs.at(-1)
		assert.equal(dialog.options.title, "Choose application")
		dialog.respond(path)
	}
	choose("/opt/my app/run`x`")
	assert.deepEqual(fixture.dialogs[0].default_filter.mime_types, [
		"application/x-executable",
		"application/x-elf",
		"application/vnd.appimage",
		"application/x-shellscript",
		"text/x-shellscript",
	])
	assert.equal(fixture.dialogs[0].default_filter.name, "Applications")
	assert.deepEqual(fixture.state(), {
		...blank_form,
		name: "run`x`",
		command: '"/opt/my app/run\\`x\\`"',
		icon: "application-x-executable",
		target: "run`x`",
	})
	fixture.field("New Launcher").props.onNotifyText({ text: "Kept" })
	choose("/bin/other")
	assert.equal(fixture.state().name, "Kept")
	assert.equal(fixture.state().icon, "application-x-executable")
	assert.equal(fixture.state().target, "other")
	choose("/")
	assert.equal(fixture.state().target, "Application")
})

test("the working directory picker, clear button and terminal switch edit the form", async () => {
	const fixture = await launcher_fixture()
	fixture.DesktopLauncherCreator.open("m")
	const form = fixture.page_named("form")
	const picker = fixture.by_class(form, "folder-picker")[0]
	const clear = fixture.by_class(form, "clear-folder")[0]
	const label = () => read(nodes(picker, "label")[0].props.label)
	assert.equal(label(), "Choose")
	assert.equal(read(clear.props.visible), false)
	picker.props.onClicked()
	const dialog = fixture.dialogs.at(-1)
	assert.equal(dialog.options.title, "Choose working directory")
	assert.equal(dialog.call[0], "folder")
	dialog.respond("/home/test/work/")
	assert.equal(label(), "Choose")
	picker.props.onClicked()
	fixture.dialogs.at(-1).respond(" /home/test/work ")
	assert.equal(label(), "work")
	assert.equal(read(clear.props.visible), true)
	clear.props.onClicked()
	assert.equal(fixture.state().working_directory, "")
	nodes(form, "switch")[0].props.onNotifyActive({
		active: true,
	})
	assert.equal(fixture.state().terminal, true)
})

test("create explains what is missing and creates a launcher with the form", async () => {
	const fixture = await launcher_fixture()
	fixture.DesktopLauncherCreator.open("monitor:7")
	const form = fixture.page_named("form")
	const create_button = fixture.button_with_label(form, "Create Launcher")
	const tooltip = () =>
		read(
			nodes(form)
				.filter(
					(item) => item.type === "box" && item.props.tooltipText !== undefined,
				)
				.at(-1)!.props.tooltipText,
		)
	assert.equal(tooltip(), "Enter a launcher name and command.")
	assert.equal(read(create_button.props.sensitive), false)
	fixture.field("New Launcher").props.onNotifyText({ text: " App " })
	assert.equal(tooltip(), "Enter a command or choose an application.")
	fixture.field("New Launcher").props.onNotifyText({ text: " " })
	fixture.field("application --option").props.onNotifyText({ text: "app" })
	assert.equal(tooltip(), "Enter a launcher name.")
	fixture.field("New Launcher").props.onNotifyText({ text: "App" })
	fixture.field("Add a description").props.onNotifyText({ text: "Does" })
	assert.equal(tooltip(), "Create the launcher on the desktop")
	assert.equal(read(create_button.props.sensitive), true)
	nodes(form, "switch")[0].props.onNotifyActive({
		active: true,
	})
	fixture.by_class(form, "folder-picker")[0].props.onClicked()
	fixture.dialogs.at(-1).respond("/work")

	fixture.set_create_result(null)
	await create_button.props.onClicked()
	assert.equal(
		fixture.state().error,
		"Could not create the launcher. Check the selected application and try again.",
	)
	fixture.set_create_result("/home/test/Desktop/App.desktop")
	await create_button.props.onClicked()
	assert.deepEqual(fixture.created, [
		[
			"monitor:7",
			{
				kind: "launcher",
				name: "App",
				comment: "Does",
				command: "app",
				icon: "",
				working_directory: "/work",
				terminal: true,
			},
		],
		[
			"monitor:7",
			{
				kind: "launcher",
				name: "App",
				comment: "Does",
				command: "app",
				icon: "",
				working_directory: "/work",
				terminal: true,
			},
		],
	])
	assert.deepEqual(fixture.events.slice(-2), [
		["select", ["/home/test/Desktop/App.desktop"]],
		["hide"],
	])
	assert.deepEqual(fixture.state(), blank_form)
})

test("create drops terminal and working directory for folder targets and ignores double clicks", async () => {
	const fixture = await launcher_fixture()
	fixture.directories.add("/data")
	fixture.DesktopLauncherCreator.open("m")
	const form = fixture.page_named("form")
	fixture.field("New Launcher").props.onNotifyText({ text: "Data" })
	fixture.field("application --option").props.onNotifyText({
		text: 'xdg-open "/data"',
	})
	nodes(form, "switch")[0].props.onNotifyActive({
		active: true,
	})
	const create_button = fixture.button_with_label(form, "Create Launcher")
	await Promise.all([
		create_button.props.onClicked(),
		create_button.props.onClicked(),
	])
	assert.equal(fixture.created.length, 1)
	assert.deepEqual(fixture.created[0][1], {
		kind: "launcher",
		name: "Data",
		comment: "",
		command: 'xdg-open "/data"',
		icon: "",
		working_directory: "",
		terminal: false,
	})
	assert.deepEqual(
		fixture.events.filter((event) => event[0] === "query").at(-1),
		["query", "/data", "none"],
	)
})

test("a command opening a folder hides the application options after the debounce", async () => {
	const fixture = await launcher_fixture()
	fixture.directories.add("/data")
	fixture.directories.add("/uri dir")
	fixture.DesktopLauncherCreator.open("m")
	assert.equal(fixture.debounced[0].ms, 250)
	const command = fixture.field("application --option")
	const options_visible = () => fixture.state().application_options
	const set_command = async (text: string) => {
		command.props.onNotifyText({ text })
		await fixture.flush_command_check()
		return options_visible()
	}
	assert.deepEqual(
		[
			await set_command('xdg-open "/data"'),
			await set_command("xdg-open /file"),
			await set_command('xdg-open "file:///uri%20dir"'),
			await set_command("xdg-open relative"),
			await set_command("xdg-open /data extra"),
			await set_command("open /data"),
			await set_command("xdg-open 'broken"),
			await set_command("xdg-open /missing"),
			await set_command(""),
		],
		[false, true, false, true, true, true, true, true, true],
	)
	command.props.onNotifyText({ text: 'xdg-open "/data"' })
	command.props.onNotifyText({ text: "xdg-open /file" })
	fixture.debounced[0].call()
	command.props.onNotifyText({ text: 'xdg-open "/data"' })
	fixture.debounced[0].call()
	await tick()
	assert.equal(options_visible(), false)
	const cancellables = fixture.events.filter((event) => event[0] === "query")
	assert.ok(cancellables.every((event) => event[2] === "cancellable"))
	command.props.onNotifyText({ text: "pending" })
	assert.equal(fixture.debounced[0].pending, true)
	for (const cleanup of fixture.cleanups) cleanup()
	assert.equal(fixture.debounced[0].pending, false)
	command.props.onNotifyText({ text: "after cleanup" })
	assert.equal(fixture.debounced[0].pending, false)
})

test("a stale command check does not overwrite a newer one", async () => {
	const fixture = await launcher_fixture()
	fixture.directories.add("/data")
	fixture.DesktopLauncherCreator.open("m")
	fixture.hold_queries()
	const command = fixture.field("application --option")
	command.props.onNotifyText({ text: "xdg-open /file" })
	fixture.debounced[0].call()
	command.props.onNotifyText({ text: 'xdg-open "/data"' })
	fixture.debounced[0].call()
	const [stale, fresh] = fixture.held_queries
	fresh()
	await tick()
	assert.equal(fixture.state().application_options, false)
	stale()
	await tick()
	assert.equal(fixture.state().application_options, false)
})

test("typing a command marks the target custom while programmatic sets keep it", async () => {
	const fixture = await launcher_fixture()
	fixture.add_volume({ name: "Disk", path: "/d" })
	fixture.DesktopLauncherCreator.open("m")
	fixture.location_rows()[0].props.onClicked()
	assert.equal(fixture.state().application_options, false)
	const command = fixture.field("application --option")
	command.props.onNotifyText({ text: 'xdg-open "/d"' })
	assert.equal(fixture.state().application_options, false)
	command.props.onNotifyText({ text: "something else" })
	await fixture.flush_command_check()
	assert.equal(fixture.state().application_options, true)
})

function sample_apps(fixture) {
	const { application } = fixture
	return [
		new application({ name: "Beta", frequency: 1, executable: "beta-bin" }),
		new application({
			name: "Alpha",
			frequency: 1,
			description: "Edits Things",
			executable: "alpha",
			icon: "alpha-icon",
			keys: { Path: "/srv", Terminal: "TRUE" },
		}),
		new application({ name: "Gamma", frequency: 5 }),
	]
}

test("the application catalog sorts by frequency then name and searches name, description and executable", async () => {
	const fixture = await launcher_fixture()
	const [beta, alpha, gamma] = sample_apps(fixture)
	fixture.applications.list = [beta, alpha, gamma]
	fixture.DesktopLauncherCreator.open("m")
	const { sorter, filter } = fixture.catalog
	assert.equal(sorter!(gamma, beta), -1)
	assert.equal(sorter!(beta, gamma), 1)
	assert.equal(sorter!(alpha, beta), -1)
	assert.equal(sorter!(beta, alpha), 1)
	assert.equal(sorter!(beta, beta), 0)
	assert.deepEqual(
		fixture.events.filter((event) => event[0] === "sorted_incremental"),
		[["sorted_incremental", true]],
	)
	assert.equal(fixture.catalog.filtered.incremental, false)
	assert.equal(filter!({}), false)
	const search = fixture.page_named("applications")
	const entry = nodes(search, "entry")[0]
	const matches = (text: string) => {
		entry.props.onNotifyText({ text })
		return [beta, alpha, gamma].filter(filter!).map((app) => app.get_name())
	}
	assert.deepEqual(matches(""), ["Beta", "Alpha", "Gamma"])
	assert.deepEqual(matches(" THINGS "), ["Alpha"])
	assert.deepEqual(matches("bin"), ["Beta"])
	assert.deepEqual(matches("gam"), ["Gamma"])
	assert.equal(fixture.catalog.filter_changes, 3)
	const before = fixture.events.length
	matches(" gam")
	assert.equal(fixture.catalog.filter_changes, 3)
	assert.deepEqual(fixture.events.slice(before), [
		["scroll", "application-list"],
	])
	matches("zzz")
	const placeholder = nodes(search, "placeholder")[0]
	assert.equal(read(placeholder.props.visible), true)

	gamma.fields.name = "Renamed"
	assert.deepEqual(matches("gam"), ["Renamed"])
	assert.deepEqual(matches("renamed"), [])

	fixture.publish_applications([gamma])
	assert.deepEqual(fixture.catalog.sorted.model.items, [gamma])
})

test("application cells bind, select and tear down", async () => {
	const fixture = await launcher_fixture()
	const [beta, alpha] = sample_apps(fixture)
	fixture.applications.list = [beta, alpha]
	fixture.DesktopLauncherCreator.open("m")
	const factory = fixture.catalog.application_factory!
	const item: Record<string, any> = {
		position: 0,
		item: alpha,
		set_activatable: (value) => (item.activatable = value),
		set_selectable: (value) => (item.selectable = value),
		set_child: (child) => (item.child = child),
		get_item: () => item.item,
		get_position: () => item.position,
	}
	factory.emit("setup", item)
	assert.equal(item.activatable, false)
	assert.equal(item.selectable, false)
	const cell = item.child
	cell.props.onClicked()
	assert.equal(fixture.state().name, "")
	factory.emit("bind", item)
	const labels = nodes(cell, "label")
	assert.deepEqual(
		[labels[0].label, labels[1].label],
		["Alpha", "Edits Things"],
	)
	assert.deepEqual([...cell.classes], ["application-option", "first"])
	assert.equal(read(nodes(cell, "app_icon")[0].props.icon), "alpha-icon")
	item.position = 1
	item.item = beta
	factory.emit("bind", item)
	assert.deepEqual([...cell.classes], ["application-option", "last"])
	assert.deepEqual([labels[0].label, labels[1].label], ["Beta", "beta-bin"])
	assert.equal(read(nodes(cell, "app_icon")[0].props.icon), icons.fallback.app)
	item.item = alpha
	factory.emit("bind", item)
	cell.props.onClicked()
	assert.deepEqual(fixture.state(), {
		...blank_form,
		name: "Alpha",
		comment: "Edits Things",
		command: "alpha",
		icon: "alpha-icon",
		target: "Alpha",
		working_directory: "/srv",
		terminal: true,
	})
	item.item = beta
	factory.emit("bind", item)
	cell.props.onClicked()
	assert.deepEqual(fixture.state(), {
		...blank_form,
		name: "Beta",
		command: "beta-bin",
		icon: "application-x-executable",
		target: "Beta",
	})
	factory.emit("unbind", item)
	fixture.field("New Launcher").props.onNotifyText({ text: "Kept" })
	cell.props.onClicked()
	assert.equal(fixture.state().name, "Kept")
	item.item = {}
	factory.emit("bind", item)
	factory.emit("teardown", item)
	assert.equal(item.child, null)
	assert.deepEqual(fixture.events.at(-1), ["dispose"])
	factory.emit("teardown", item)
	assert.deepEqual(
		fixture.events.filter((event) => event[0] === "dispose").length,
		1,
	)
})

test("the application selector opens once both list models settle", async () => {
	const fixture = await launcher_fixture()
	fixture.applications.list = sample_apps(fixture)
	fixture.DesktopLauncherCreator.open("m")
	const picker = fixture.by_class(
		fixture.page_named("form"),
		"application-picker",
	)[0]
	const entry = nodes(fixture.page_named("applications"), "entry")[0]
	const grid = nodes(fixture.page_named("applications"), "grid")[0]
	entry.props.onNotifyText({ text: "alp" })
	fixture.app_pending.filtered = 1
	picker.props.onClicked()
	assert.equal(read(entry.props.text), "")
	fixture.run_idles()
	assert.equal(fixture.current_page(), "form")
	fixture.app_pending.filtered = 0
	fixture.app_pending.sorted = 1
	fixture.catalog.filtered.emit("notify::pending")
	fixture.run_idles()
	assert.equal(fixture.current_page(), "form")
	fixture.app_pending.sorted = 0
	fixture.catalog.sorted.emit("notify::pending")
	const before = fixture.events.length
	fixture.run_idles()
	assert.equal(fixture.current_page(), "applications")
	assert.deepEqual(fixture.events.slice(before), [
		["scroll", "application-list"],
	])
	fixture.catalog.sorted.emit("notify::pending")
	assert.equal(fixture.idles.length, 0)
	assert.ok(grid)

	picker.props.onClicked()
	fixture
		.by_class(fixture.page_named("form"), "icon-editor")[0]
		.props.onClicked()
	fixture.run_idles()
	assert.equal(fixture.current_page(), "icons")
	for (const cleanup of fixture.cleanups) cleanup()
	assert.equal(fixture.catalog.filtered.count("notify::pending"), 0)
	assert.equal(fixture.catalog.sorted.count("notify::pending"), 0)
})

test("icon search filters asynchronously and shows all, filtered or empty results", async () => {
	const fixture = await launcher_fixture()
	fixture.set_icon_names(["edit-copy", "edit-paste", "folder"])
	fixture.DesktopLauncherCreator.open("m")
	fixture
		.by_class(fixture.page_named("form"), "icon-editor")[0]
		.props.onClicked()
	assert.deepEqual(
		fixture.events.filter((event) => event[0] === "scroll"),
		[["scroll", "icon-grid"]],
	)
	const icons_page = fixture.page_named("icons")
	const entry = nodes(icons_page, "entry")[0]
	const grids = nodes(icons_page, "scrolled")
	const placeholder = nodes(icons_page, "placeholder")[0]
	const shown = () => [
		read(grids[0].props.visible),
		read(grids[1].props.visible),
		read(placeholder.props.visible),
	]
	const scrolls = () => fixture.events.filter((event) => event[0] === "scroll")
	assert.deepEqual(shown(), [true, false, false])
	assert.equal(fixture.current_page(), "icons")
	fixture.events.length = 0

	entry.props.onNotifyText({ text: " EDIT " })
	assert.equal(read(entry.props.text), " EDIT ")
	assert.deepEqual(shown(), [false, true, false])
	const [candidate] = fixture.catalog.icon_candidates
	assert.equal(candidate.filter.search, "EDIT")
	assert.equal(candidate.filter.ignore_case, true)
	assert.equal(candidate.filter.match_mode, 1)
	assert.equal(candidate.incremental, true)
	assert.equal(fixture.catalog.icon_filtered_selection.model, candidate)
	assert.equal(candidate.count("notify::pending"), 0)

	entry.props.onNotifyText({ text: "EDIT" })
	assert.deepEqual(scrolls(), [
		["scroll", "icon-grid"],
		["scroll", "icon-grid"],
	])

	fixture.set_icon_pending(1)
	entry.props.onNotifyText({ text: "fold" })
	const pending = fixture.catalog.icon_candidates[1]
	assert.equal(pending.count("notify::pending"), 1)
	assert.deepEqual(shown(), [false, true, false])
	pending.emit("notify::pending")
	assert.deepEqual(shown(), [false, true, false])
	fixture.set_icon_pending(0)
	pending.emit("notify::pending")
	assert.equal(pending.count("notify::pending"), 0)
	assert.equal(fixture.catalog.icon_filtered_selection.model, pending)

	fixture.set_icon_pending(1)
	entry.props.onNotifyText({ text: "zzz" })
	const abandoned = fixture.catalog.icon_candidates[2]
	entry.props.onNotifyText({ text: "nothing" })
	assert.equal(abandoned.model, null)
	assert.equal(abandoned.count("notify::pending"), 0)
	fixture.set_icon_pending(0)
	const empty = fixture.catalog.icon_candidates[3]
	empty.emit("notify::pending")
	assert.deepEqual(shown(), [false, false, true])
	entry.props.onNotifyText({ text: "nothing" })

	fixture.events.length = 0
	entry.props.onNotifyText({ text: "" })
	assert.deepEqual(shown(), [true, false, false])
	assert.deepEqual(scrolls(), [["scroll", "icon-grid"]])

	fixture.set_icon_pending(1)
	entry.props.onNotifyText({ text: "edit" })
	const cancelled = fixture.catalog.icon_candidates.at(-1)
	fixture.by_class(fixture.tree(), "back")[0].props.onClicked()
	assert.equal(fixture.current_page(), "form")
	assert.equal(cancelled.model, null)
	assert.equal(cancelled.count("notify::pending"), 0)

	const editor = fixture.by_class(fixture.page_named("form"), "icon-editor")[0]
	assert.equal(read(editor.props.tooltipText), "Choose icon")
	editor.props.onClicked()
	assert.equal(read(entry.props.text), "")
	assert.deepEqual(shown(), [true, false, false])
	const grid = nodes(icons_page, "grid")[0]
	grid.activate(grid, 1)
	assert.equal(fixture.state().icon, "edit-paste")
	assert.equal(read(editor.props.tooltipText), "edit-paste")
	assert.equal(fixture.current_page(), "form")
})

test("icon cells show the icon name", async () => {
	const fixture = await launcher_fixture()
	fixture.DesktopLauncherCreator.open("m")
	const factory = fixture.catalog.icon_factory!
	const item: Record<string, any> = {
		value: null,
		set_activatable: (value) => (item.activatable = value),
		set_child: (child) => (item.child = child),
		get_child: () => item.child,
		get_item: () => item.value,
	}
	factory.emit("setup", item)
	const cell = item.child
	assert.equal(item.activatable, true)
	assert.deepEqual(cell.options, { orientation: 1 })
	assert.deepEqual(cell.calls, [
		["class", "icon-option"],
		["halign", 3],
		["valign", 3],
		["append", "Image", cell.calls[3][2]],
		["append", "Label", cell.calls[4][2]],
	])
	const [image, label] = [cell.calls[3][2], cell.calls[4][2]]
	assert.deepEqual(image.options, { pixelSize: 32 })
	assert.deepEqual(label.options, { ellipsize: 3 })
	factory.emit("bind", item)
	assert.equal(cell.calls.length, 5)
	item.value = { get_string: () => "plain" }
	factory.emit("bind", item)
	assert.equal(cell.calls.length, 5)
	const { string_object } = fixture
	item.value = new string_object("edit-copy")
	factory.emit("bind", item)
	assert.deepEqual(cell.calls.at(-1), ["tooltip", "edit-copy"])
	assert.equal(image.icon, "edit-copy")
	assert.equal(label.label, "edit-copy")
	factory.emit("bind", { ...item, get_child: () => null })
	assert.equal(cell.calls.length, 6)
})
