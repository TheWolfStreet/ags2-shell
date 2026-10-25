import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { jsx_runtime, tick } from "../helpers.ts"

async function settings_fixture({
	visible,
	workspace,
	clients,
}: {
	visible: boolean
	workspace: number
	clients: Record<string, unknown>[]
}) {
	const calls: string[] = []
	const dialog = { visible, show: () => calls.push("show") }
	const { Settings } = await load_module("widget/Settings/index.tsx", {
		ags: {
			createComputed: () => () => false,
			createRoot: () => () => {},
			createState: () => [() => "", () => {}],
		},
		"$lib/app": {
			default: {
				get_application_id: () => "io.Astal.ags2-shell",
				get_window: (name: string) =>
					name === "settings-dialog"
						? dialog
						: { hide: () => calls.push(`hide:${name}`) },
			},
		},
		"ags/gtk4": {
			Gtk: {
				StackTransitionType: { SLIDE_LEFT_RIGHT: 1 },
				Align: { CENTER: 3 },
				Orientation: { VERTICAL: 1 },
				Window: "window",
			},
		},
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"./components/pages": { create_pages: () => [] },
		"$lib/hyprland": {
			hyprland: { clients, focusedWorkspace: { id: workspace } },
		},
		"$lib/windowing": {
			focus_client: async (client) => calls.push(`focus:${client.address}`),
			move_client_to_workspace_silent: async (id, client) =>
				calls.push(`move:${client.address}:${id}`),
			raise_client: async (client) => calls.push(`raise:${client.address}`),
		},
		"$shell/options": {
			default: {},
			collect_options: () => [],
			scaled: (px: number) => px,
		},
	})
	return { button: Settings.Button(), calls }
}

function own(workspace: number) {
	return {
		address: "0xshell",
		class: "io.Astal.ags2-shell",
		title: "Settings",
		workspace: { id: workspace },
	}
}
const other_app = {
	address: "0xother",
	class: "org.gnome.Settings",
	title: "Settings",
	workspace: { id: 1 },
}

test("opening Settings shows it when it is closed", async () => {
	const f = await settings_fixture({
		visible: false,
		workspace: 1,
		clients: [],
	})
	f.button.props.onClicked()
	await tick()
	assert.deepEqual(f.calls, ["hide:quicksettings", "show"])
})

test("an open Settings window is focused and raised, and brought over from another workspace", async () => {
	const here = await settings_fixture({
		visible: true,
		workspace: 2,
		clients: [other_app, own(2)],
	})
	here.button.props.onClicked()
	await tick()
	assert.deepEqual(here.calls, [
		"hide:quicksettings",
		"focus:0xshell",
		"raise:0xshell",
	])

	const elsewhere = await settings_fixture({
		visible: true,
		workspace: 3,
		clients: [other_app, own(2)],
	})
	elsewhere.button.props.onClicked()
	await tick()
	assert.deepEqual(elsewhere.calls, [
		"hide:quicksettings",
		"move:0xshell:3",
		"focus:0xshell",
		"raise:0xshell",
	])
})
