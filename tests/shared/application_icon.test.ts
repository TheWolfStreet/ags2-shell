import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { accessor, create_state, jsx_runtime, nodes, read } from "../helpers.ts"

async function icon_fixture() {
	const [texture, set_texture] = create_state(null as object | null)
	const requests: [string, number][] = []
	const { ApplicationIcon } = await load_module(
		"widget/shared/ApplicationIcon.tsx",
		{
			ags: {
				createBinding: (object, property) => accessor(() => object[property]),
				createComputed: (fn) => accessor(fn),
				With: ({ value, children }) => children(value()),
			},
			"ags/gtk4": {
				Gdk: {},
				Gtk: {
					Align: { CENTER: 3 },
					ContentFit: { CONTAIN: 1 },
					Picture: "picture",
				},
			},
			"ags/gtk4/jsx-runtime": jsx_runtime,
			"$lib/textures": {
				create_texture_accessor: (path: string, size: number) => {
					requests.push([path, size])
					return texture
				},
			},
			"$lib/ui": {
				read_value: (value) => (typeof value === "function" ? value() : value),
			},
		},
	)
	return { ApplicationIcon, set_texture, requests }
}

test("an image icon that cannot be decoded shows the generic application icon", async () => {
	const f = await icon_fixture()
	const tree = f.ApplicationIcon({ icon: "/icons/broken.png", size: 48 })
	const [picture] = nodes(tree, "picture")
	const [fallback] = nodes(tree, "image")
	assert.deepEqual(f.requests, [["/icons/broken.png", 64]])
	assert.equal(read(picture.props.visible), false)
	assert.equal(read(fallback.props.visible), true)
	assert.equal(fallback.props.iconName, "image-missing")

	f.set_texture({ texture: "decoded" })
	assert.equal(read(picture.props.visible), true)
	assert.equal(read(fallback.props.visible), false)
})

test("a themed icon name renders as an image without loading a file", async () => {
	const f = await icon_fixture()
	const tree = f.ApplicationIcon({ icon: "steam", size: 32 })
	assert.deepEqual(f.requests, [])
	assert.equal(nodes(tree, "picture").length, 0)
	assert.equal(nodes(tree, "image")[0].props.iconName, "steam")
})
