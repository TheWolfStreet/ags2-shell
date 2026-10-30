import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import icons from "../../lib/icons.ts"
import { accessor, jsx_runtime, nodes } from "../helpers.ts"

function fake_option(value: unknown = "value"): any {
	const opt = accessor(() => value)
	return new Proxy(opt, {
		get(target, key) {
			if (key in target) return target[key]
			if (key === "get_default") return () => value
			if (key === "reset") return () => {}
			if (typeof key === "symbol") return undefined
			return fake_option()
		},
	})
}

class monitor {
	declare width: number
	declare height: number
	declare scale: number
	constructor(width: number, height: number, scale: number) {
		this.width = width
		this.height = height
		this.scale = scale
	}
	get_geometry() {
		return { width: this.width, height: this.height }
	}
	get_scale() {
		return this.scale
	}
}

async function load_pages(monitors: monitor[]) {
	const requests: unknown[][] = []
	const previews: number[] = []
	const { create_pages } = await load_module(
		"widget/Settings/components/pages.tsx",
		{
			"ags/gtk4": {
				Gdk: {
					BUTTON_PRIMARY: 1,
					BUTTON_MIDDLE: 2,
					Cursor: { new_from_name: () => ({}) },
					Monitor: monitor,
					Display: {
						get_default: () => ({
							get_monitors: () => ({
								get_n_items: () => monitors.length,
								get_item: (index: number) => monitors[index] ?? null,
							}),
						}),
					},
				},
				Gtk: {
					Align: { START: 1, CENTER: 3, END: 2 },
					Orientation: { VERTICAL: 1 },
					ContentFit: { COVER: 2 },
					RevealerTransitionType: { CROSSFADE: 1 },
					ScrolledWindow: "scrolled",
					GestureClick: "click",
					Picture: "picture",
				},
			},
			"ags/gtk4/jsx-runtime": jsx_runtime,
			ags: {
				createBinding: () => accessor(() => []),
				createComputed: accessor,
				onCleanup: () => {},
			},
			"gi://Gio": { default: {} },
			"./Setter": { default: (props) => jsx_runtime.jsx("setter", props) },
			"widget/shared/Placeholder": { Placeholder: () => null },
			"$service/asusctl": { asusctl: {} },
			"$lib/wallpaper": {
				clear_wallpaper() {},
				ensure_wallpaper_preview: (size: number) => previews.push(size),
				set_wallpaper: async () => ({ ok: true }),
				wallpaper_path: "/cache/wallpaper",
				wallpaper_preview: accessor(() => "/cache/wallpaper-preview"),
				wallpaper_revision: accessor(() => 1),
			},
			"$lib/files": {
				file_exists: () => true,
				file_size: () => ({ ok: true, value: 10 }),
			},
			"$lib/icons": { default: icons },
			"$lib/notifications": { notify() {} },
			"$lib/textures": {
				create_display_texture: (...args) => {
					requests.push(args)
					return accessor(() => null)
				},
				hidden_drag_icon: () => "hidden",
			},
			"$lib/ui": { is_dialog_dismissed: () => false },
			"$shell/options": {
				default: fake_option(),
				Opt: class {},
				scaled: (px) => accessor(() => px),
			},
		},
	)
	const pages = create_pages().map((page) => page.widget)
	const picture = nodes(pages, "picture")[0]
	picture.props.paintable()
	return { requests, previews, pages }
}

test("the wallpaper preview is cached at the largest monitor's pixel size", async () => {
	const { requests, previews } = await load_pages([
		new monitor(1920, 1080, 1),
		new monitor(1707, 1067, 1.5),
	])
	assert.deepEqual(previews, [2561])
	assert.deepEqual(requests, [["/cache/wallpaper-preview", 2561]])
})

test("a rotated monitor counts its long edge", async () => {
	const { requests, previews } = await load_pages([new monitor(1200, 1920, 1)])
	assert.deepEqual(previews, [1920])
	assert.deepEqual(requests, [["/cache/wallpaper-preview", 1920]])
})
