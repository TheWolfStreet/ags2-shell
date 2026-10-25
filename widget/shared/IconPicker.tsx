import { createState, onCleanup, type Accessor } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { Placeholder } from "widget/shared/Placeholder"

const { CENTER } = Gtk.Align
const { HORIZONTAL, VERTICAL } = Gtk.Orientation

type results_page = "all" | "filtered" | "empty"

type icon_picker_props = {
	active: Accessor<boolean>
	on_pick: (name: string) => void
}

function scroll_to_top(grid: Gtk.GridView | null) {
	grid?.scroll_to(0, Gtk.ListScrollFlags.NONE, null)
}

function create_icon_factory() {
	const factory = Gtk.SignalListItemFactory.new()
	const cells = new WeakMap<
		Gtk.ListItem,
		{ image: Gtk.Image; label: Gtk.Label }
	>()
	factory.connect("setup", (_factory, object) => {
		const item = object as Gtk.ListItem
		const image = new Gtk.Image({ pixelSize: 32 })
		const label = new Gtk.Label({ ellipsize: Pango.EllipsizeMode.END })
		const cell = new Gtk.Box({ orientation: VERTICAL })
		cell.add_css_class("icon-option")
		cell.set_halign(CENTER)
		cell.set_valign(CENTER)
		cell.append(image)
		cell.append(label)
		item.set_activatable(true)
		item.set_child(cell)
		cells.set(item, { image, label })
	})
	factory.connect("bind", (_factory, object) => {
		const item = object as Gtk.ListItem
		const value = item.get_item()
		const cell = cells.get(item)
		if (!(value instanceof Gtk.StringObject) || !cell) return
		const icon_name = value.get_string()
		cell.image.set_from_icon_name(icon_name)
		cell.label.set_label(icon_name)
		item.get_child()?.set_tooltip_text(icon_name)
	})
	return factory
}

export function IconPicker({ active, on_pick }: icon_picker_props) {
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
	const base_selection = Gtk.NoSelection.new(icon_model)
	const filtered_selection = Gtk.NoSelection.new(null)
	const [search, set_search] = createState("")
	const [results, set_results] = createState<results_page>("all")
	const factory = create_icon_factory()
	let base_grid: Gtk.GridView | null = null
	let filtered_grid: Gtk.GridView | null = null
	let query = ""
	let pending_model: Gtk.FilterListModel | null = null
	let pending_handler = 0
	let was_active = active.peek()

	function update_query(value: string) {
		set_search(value)
		const next_query = value.trim()
		if (next_query === query) {
			reset_anchor()
			return
		}
		query = next_query
		cancel_pending_filter()
		if (!next_query) {
			set_results("all")
			scroll_to_top(base_grid)
			return
		}

		const filter = Gtk.StringFilter.new(icon_expression)
		filter.set_ignore_case(true)
		filter.set_match_mode(Gtk.StringFilterMatchMode.SUBSTRING)
		filter.set_search(next_query)
		const candidate = Gtk.FilterListModel.new(null, filter)
		candidate.set_incremental(true)
		pending_model = candidate
		const finish = () => {
			if (pending_model !== candidate || candidate.get_pending() > 0) return
			candidate.disconnect(pending_handler)
			pending_handler = 0
			pending_model = null
			filtered_selection.set_model(candidate)
			if (candidate.get_n_items() === 0) {
				set_results("empty")
				return
			}
			scroll_to_top(filtered_grid)
			set_results("filtered")
		}
		pending_handler = candidate.connect("notify::pending", finish)
		candidate.set_model(icon_model)
		finish()
	}

	function cancel_pending_filter() {
		if (!pending_model) return
		if (pending_handler) pending_model.disconnect(pending_handler)
		pending_model.set_model(null)
		pending_model = null
		pending_handler = 0
	}

	function reset_anchor() {
		const current = results.peek()
		if (current === "all") scroll_to_top(base_grid)
		if (current === "filtered") scroll_to_top(filtered_grid)
	}

	function follow_active() {
		const now = active.peek()
		if (now === was_active) return
		was_active = now
		if (now) update_query("")
		else cancel_pending_filter()
	}

	onCleanup(active.subscribe(follow_active))
	onCleanup(cancel_pending_filter)

	function ResultsGrid({
		selection,
		page,
		set_grid,
	}: {
		selection: Gtk.NoSelection
		page: results_page
		set_grid: (grid: Gtk.GridView) => void
	}) {
		return (
			<Gtk.ScrolledWindow
				visible={results.as((current) => current === page)}
				vexpand
				hscrollbarPolicy={Gtk.PolicyType.NEVER}
			>
				<Gtk.GridView
					class="icon-grid"
					model={selection}
					factory={factory}
					minColumns={3}
					maxColumns={8}
					singleClickActivate
					$={(self) => {
						set_grid(self)
						self.connect("activate", (_grid, position) => {
							const value = selection.get_item(position)
							if (value instanceof Gtk.StringObject) on_pick(value.get_string())
						})
					}}
				/>
			</Gtk.ScrolledWindow>
		)
	}

	return (
		<box class="icon-picker selector-content" orientation={VERTICAL} vexpand>
			<box class="icon-search-row" orientation={HORIZONTAL}>
				<entry
					class="selector-search"
					placeholderText="Search icons"
					primaryIconName={icons.ui.search}
					text={search}
					hexpand
					onNotifyText={(self) => update_query(self.text)}
				/>
			</box>
			<box class="selector-results-surface" orientation={VERTICAL} vexpand>
				<ResultsGrid
					selection={base_selection}
					page="all"
					set_grid={(grid) => {
						base_grid = grid
					}}
				/>
				<ResultsGrid
					selection={filtered_selection}
					page="filtered"
					set_grid={(grid) => {
						filtered_grid = grid
					}}
				/>
				<Placeholder
					iconName={icons.ui.search}
					label="No results found"
					visible={results.as((current) => current === "empty")}
				/>
			</box>
		</box>
	)
}
