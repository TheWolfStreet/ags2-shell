import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import icons from "../../lib/icons.ts"
import { create_state, nodes, read, string_object } from "../helpers.ts"

async function picker_fixture(names: string[]) {
	const scrolls: unknown[] = []
	const cleanups: (() => void)[] = []
	const candidates: any[] = []
	let pending = 0

	function make(type, props: Record<string, any> = {}) {
		if (typeof type === "function") return type(props)
		const children = [props.children].flat().filter(Boolean)
		const tree: Record<string, any> = {
			type,
			props,
			children,
			connect(signal, handler) {
				if (signal === "activate") tree.activate = handler
				return 1
			},
			scroll_to: () => scrolls.push(props.class),
		}
		props.$?.(tree)
		return tree
	}

	function filter_model(_model, filter) {
		const handlers = new Map<number, () => void>()
		const model: any = {
			filter,
			model: null,
			handlers,
			set_incremental() {},
			set_model: (next) => (model.model = next),
			get_pending: () => pending,
			get items() {
				return (model.model?.items ?? []).filter((name: string) =>
					name.includes(filter.search),
				)
			},
			get_n_items: () => model.items.length,
			connect: (_signal, handler) => {
				handlers.set(handlers.size + 1, handler)
				return handlers.size
			},
			disconnect: (id) => handlers.delete(id),
		}
		candidates.push(model)
		return model
	}

	const gtk = {
		Align: { CENTER: 3 },
		Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
		PolicyType: { NEVER: 2 },
		ListScrollFlags: { NONE: 0 },
		StringFilterMatchMode: { SUBSTRING: 1 },
		ScrolledWindow: "scrolled",
		GridView: "grid",
		StringObject: string_object,
		IconTheme: { get_for_display: () => ({ get_icon_names: () => names }) },
		StringList: { new: (items) => ({ items }) },
		PropertyExpression: { new: () => ({}) },
		NoSelection: {
			new: (model) => {
				const selection: any = {
					model,
					set_model: (next) => (selection.model = next),
					get_item: (position) =>
						new string_object(selection.model.items[position]),
				}
				return selection
			},
		},
		StringFilter: {
			new: () => {
				const filter: Record<string, unknown> = {}
				return Object.assign(filter, {
					set_ignore_case() {},
					set_match_mode() {},
					set_search: (value) => (filter.search = value),
				})
			},
		},
		FilterListModel: { new: filter_model },
		SignalListItemFactory: { new: () => ({ connect() {} }) },
	}

	const { IconPicker } = await load_module("widget/shared/IconPicker.tsx", {
		ags: {
			createState: create_state,
			onCleanup: (fn) => cleanups.push(fn),
		},
		"ags/gtk4": { Gdk: { Display: { get_default: () => ({}) } }, Gtk: gtk },
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"gi://Pango": { default: { EllipsizeMode: { END: 3 } } },
		"$lib/icons": { default: icons },
		"widget/shared/Placeholder": {
			Placeholder: (props) => make("placeholder", props),
		},
	})

	const [active, set_active, subscribers] = create_state(false)
	const picked: string[] = []
	const root = IconPicker({ active, on_pick: (name) => picked.push(name) })
	const entry = nodes(root, "entry")[0]
	const grids = nodes(root, "scrolled")
	const placeholder = nodes(root, "placeholder")[0]
	return {
		root,
		entry,
		grid: (index: number) => nodes(grids[index], "grid")[0],
		shown: () => [
			read(grids[0].props.visible),
			read(grids[1].props.visible),
			read(placeholder.props.visible),
		],
		scrolls,
		cleanups,
		candidates,
		subscribers,
		picked,
		set_active,
		set_pending: (value: number) => {
			pending = value
		},
	}
}

test("the icon picker resets its search each time it becomes active", async () => {
	const picker = await picker_fixture(["edit-copy", "edit-paste", "folder"])
	assert.equal(picker.root.props.class, "icon-picker selector-content")
	assert.equal(picker.entry.props.placeholderText, "Search icons")
	picker.set_active(true)
	assert.deepEqual(picker.scrolls, ["icon-grid"])

	picker.entry.props.onNotifyText({ text: "edit" })
	assert.deepEqual(picker.shown(), [false, true, false])
	picker.set_active(true)
	assert.equal(read(picker.entry.props.text), "edit")

	picker.set_active(false)
	picker.set_active(true)
	assert.equal(read(picker.entry.props.text), "")
	assert.deepEqual(picker.shown(), [true, false, false])
})

test("picking an icon reports its name and nothing else", async () => {
	const picker = await picker_fixture(["edit-copy", "edit-paste", "folder"])
	picker.set_active(true)
	const grid = picker.grid(0)
	grid.activate(grid, 2)
	assert.deepEqual(picker.picked, ["folder"])
	assert.equal(read(picker.entry.props.text), "")

	picker.entry.props.onNotifyText({ text: "paste" })
	const filtered = picker.grid(1)
	filtered.activate(filtered, 0)
	assert.deepEqual(picker.picked, ["folder", "edit-paste"])
})

test("leaving the picker or disposing it cancels a pending search", async () => {
	const picker = await picker_fixture(["edit-copy", "folder"])
	picker.set_active(true)
	picker.set_pending(1)
	picker.entry.props.onNotifyText({ text: "fold" })
	const [leaving] = picker.candidates
	assert.equal(leaving.handlers.size, 1)
	picker.set_active(false)
	assert.equal(leaving.model, null)
	assert.equal(leaving.handlers.size, 0)

	picker.set_active(true)
	picker.entry.props.onNotifyText({ text: "edit" })
	const disposed = picker.candidates.at(-1)
	for (const cleanup of picker.cleanups) cleanup()
	assert.equal(disposed.model, null)
	assert.equal(disposed.handlers.size, 0)
	assert.equal(picker.subscribers.size, 0)
})
