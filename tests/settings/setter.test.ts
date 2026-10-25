import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import icons from "../../lib/icons.ts"
import { accessor, create_state, nodes, read } from "../helpers.ts"

function make(type, props: Record<string, any> = {}) {
	if (typeof type === "function") return type(props)
	const children = [props.children].flat().filter(Boolean)
	const tree: Record<string, any> = {
		type,
		props,
		children,
		popdowns: 0,
		popdown: () => tree.popdowns++,
	}
	props.$?.(tree)
	return tree
}

function option(initial, editor: string, choices: unknown[] | null = null) {
	const [value, set] = create_state(initial)
	const changes: unknown[] = []
	return Object.assign(value, {
		changes,
		editor: () => editor,
		choices: () => choices,
		get_default: () => initial,
		set: (next) => {
			changes.push(next)
			set(next)
		},
		reset: () => set(initial),
	})
}

const choices: { anchor: unknown; on_pick: (name: string) => void }[] = []

const { default: Setter } = await load_module(
	"widget/Settings/components/Setter.tsx",
	{
		ags: { createComputed: (fn) => accessor(fn), createState: create_state },
		"ags/gtk4": {
			Gdk: { RGBA: class {} },
			Gtk: {
				Align: { CENTER: 3 },
				FontLevel: { FONT: 2 },
				CustomFilter: class {
					set_filter_func() {}
				},
				FontDialog: class {
					set_filter() {}
				},
			},
		},
		"ags/gtk4/jsx-runtime": { jsx: make, jsxs: make },
		"gi://GObject": { default: {} },
		"gi://Pango": {
			default: {
				FontDescription: {},
				FontFamily: class {},
				FontFace: class {},
				SCALE: 1024,
				EllipsizeMode: { END: 3 },
			},
		},
		"$lib/icons": { default: icons },
		"$lib/ui": { is_dialog_dismissed: () => false, read_value: read },
		"$shell/options": { Opt: class {}, scaled: (px) => accessor(() => px) },
		"widget/shared/icon_chooser": {
			choose_icon: (anchor, on_pick) => choices.push({ anchor, on_pick }),
		},
	},
)

test("an enum without choices reads Unavailable and is insensitive", () => {
	const [rates, set_rates] = create_state([])
	const rate = option(120, "number")
	const setter = Setter({ opt: rate, enums: rates })
	assert.equal(setter.props.class, "enum-setter")
	assert.equal(read(setter.props.sensitive), false)
	assert.equal(read(nodes(setter, "label")[0].props.label), "Unavailable")

	set_rates([60, 144])
	assert.equal(read(setter.props.sensitive), true)
	assert.equal(read(nodes(setter, "label")[0].props.label), "120")
	nodes(setter, "button")[1].props.onClicked()
	assert.deepEqual(rate.changes, [60])
})

test("an icon option shows only its icon, names it in the tooltip and picks through the chooser", () => {
	const icon = option("nix-snowflake", "icon")
	const setter = Setter({ opt: icon })
	assert.equal(setter.type, "button")
	assert.equal(nodes(setter, "label").length, 0)
	assert.equal(read(nodes(setter, "image")[0].props.iconName), "nix-snowflake")
	assert.equal(read(setter.props.tooltipText), "nix-snowflake")

	setter.props.onClicked(setter)
	assert.equal(choices.length, 1)
	assert.equal(choices[0].anchor, setter)
	assert.deepEqual(icon.changes, [])

	choices[0].on_pick("folder")
	assert.deepEqual(icon.changes, ["folder"])
	assert.equal(read(nodes(setter, "image")[0].props.iconName), "folder")
	assert.equal(read(setter.props.tooltipText), "folder")

	icon.reset()
	assert.equal(read(nodes(setter, "image")[0].props.iconName), "nix-snowflake")
	icon.set("")
	assert.equal(read(setter.props.tooltipText), "Choose icon")
	icon.set("/home/user/Pictures/picture.png")
	assert.equal(read(setter.props.tooltipText), "picture.png")
})
