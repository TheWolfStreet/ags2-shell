import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { load_module } from "../load_module.ts"
import {
	accessor,
	with_node,
	create_state,
	jsx_runtime,
	make,
	nodes,
	tick,
} from "../helpers.ts"

function fake_window(log: string[], name: string) {
	return {
		visible: false,
		is_visible() {
			return this.visible
		},
		show() {
			this.visible = true
			log.push(`${name}.show`)
		},
		hide() {
			this.visible = false
			log.push(`${name}.hide`)
		},
	}
}

async function power_fixture({
	layout = "line",
	exec = async (_command: string) => "",
} = {}) {
	const log: string[] = []
	const errors: unknown[][] = []
	const windows = {
		verification: fake_window(log, "verification") as any,
		powermenu: fake_window(log, "powermenu"),
	}
	mock.method(console, "error", (...args) => errors.push(args))
	const module = await load_module("widget/PowerMenu/index.tsx", {
		ags: {
			createState: create_state,
			With: with_node,
		},
		"ags/process": {
			execAsync: (command) => {
				log.push(`exec:${command}`)
				return exec(command)
			},
		},
		"ags/gtk4": {
			Gtk: {
				Align: { END: 2 },
				RevealerTransitionType: { CROSSFADE: 8 },
				Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
			},
		},
		"ags/gtk4/jsx-runtime": jsx_runtime,
		"$lib/app": { default: { get_window: (name) => windows[name] ?? null } },
		"widget/shared/PopupWindow": {
			PopupWindow: (props) => make("popup", props),
		},
		"widget/Bar/components/PanelButton": {
			PanelButton: (props) => make("panel", props),
		},
		"$lib/icons": {
			default: {
				powermenu: {
					shutdown: "shutdown-icon",
					logout: "logout-icon",
					reboot: "reboot-icon",
					sleep: "sleep-icon",
				},
			},
		},
		"$shell/options": {
			default: {
				powermenu: {
					layout: accessor(() => layout),
					labels: accessor(() => true),
					sleep: accessor(() => "systemctl suspend"),
					reboot: accessor(() => "systemctl reboot"),
					logout: accessor(() => "logout"),
					shutdown: accessor(() => "shutdown now"),
				},
			},
			scaled: (value) => value,
		},
	})
	const modal = module.PowerMenu.VerificationModal()
	const [cancel, confirm] = nodes(modal, "button")
	const [title, description] = nodes(modal, "label")
	return {
		module,
		windows,
		log,
		errors,
		modal,
		cancel,
		confirm,
		title,
		description,
	}
}

test.afterEach(() => mock.restoreAll())

test("the menu lays out its four actions by the configured layout", async () => {
	const line = await power_fixture({ layout: "line" })
	const menu = line.module.PowerMenu.Window()
	assert.equal(menu.props.name, "powermenu")
	assert.equal(menu.props.transitionType, 8)
	assert.equal(menu.props.children.props.class(), "powermenu horizontal line")
	const labels = nodes(menu, "label").map((node) => node.props.label)
	assert.deepEqual(labels, ["Shutdown", "Log Out", "Reboot", "Sleep"])
	const rows = nodes(menu, "box").filter((node) => node.props.homogeneous)
	assert.equal(rows.length, 1)
	assert.equal(rows[0].props.orientation, 0)

	const grid = await power_fixture({ layout: "box" })
	const boxed = grid.module.PowerMenu.Window()
	const columns = nodes(boxed, "box").filter(
		(node) =>
			node.props.orientation === 1 && nodes(node, "button").length === 2,
	)
	assert.deepEqual(
		columns.map((column) =>
			nodes(column, "label").map((node) => node.props.label),
		),
		[
			["Shutdown", "Log Out"],
			["Reboot", "Sleep"],
		],
	)
	const unknown = await power_fixture({ layout: "other" })
	assert.equal(nodes(unknown.module.PowerMenu.Window(), "button").length, 0)

	const button = line.module.PowerMenu.Button()
	assert.equal(button.props.target_window, "powermenu")
})

test("an action button asks for confirmation once", async () => {
	const f = await power_fixture()
	const menu = f.module.PowerMenu.Window()
	nodes(menu, "button")[2].props.onClicked()
	assert.equal(f.title.props.label(), "Reboot")
	assert.equal(f.description.props.label(), "Confirm action")
	assert.deepEqual(f.log, ["verification.show"])
	f.module.PowerMenu.request_action_confirmation("sleep")
	assert.equal(f.title.props.label(), "Reboot")
	assert.deepEqual(f.log, ["verification.show"])
})

test("confirmation is skipped without a verification window", async () => {
	const f = await power_fixture()
	f.windows.verification = null
	f.module.PowerMenu.request_action_confirmation("sleep")
	assert.equal(f.title.props.label(), "")
})

test("confirming runs the configured command after closing both windows", async () => {
	const f = await power_fixture()
	f.module.PowerMenu.request_action_confirmation("shutdown")
	f.log.length = 0
	await f.confirm.props.onClicked()
	assert.deepEqual(f.log, [
		"verification.hide",
		"powermenu.hide",
		"exec:shutdown now",
	])
	assert.equal(f.confirm.props.sensitive(), true)
	assert.equal(f.errors.length, 0)
})

test("a failed command is logged and the confirmation reopens with the error", async () => {
	let finish: (value: unknown) => void = () => {}
	const f = await power_fixture({
		exec: () =>
			new Promise((_resolve, reject) => {
				finish = reject
			}),
	})
	f.module.PowerMenu.request_action_confirmation("reboot")
	f.log.length = 0
	const pending = f.confirm.props.onClicked()
	assert.equal(f.confirm.props.sensitive(), false)
	assert.equal(f.cancel.props.sensitive(), false)
	await f.confirm.props.onClicked()
	assert.equal(f.log.filter((entry) => entry.startsWith("exec")).length, 1)
	f.module.PowerMenu.request_action_confirmation("sleep")
	assert.equal(f.title.props.label(), "Reboot")
	finish(new Error("denied"))
	await pending
	assert.equal(f.errors.length, 1)
	assert.equal(f.errors[0][0], "powermenu.reboot: Failed to run action")
	assert.equal((f.errors[0][1] as Error).message, "denied")
	assert.equal(
		f.description.props.label(),
		"Could not reboot. Check the shell log.",
	)
	assert.equal(f.log.at(-1), "verification.show")
	assert.equal(f.confirm.props.sensitive(), true)
	f.module.PowerMenu.request_action_confirmation("sleep")
	assert.equal(f.title.props.label(), "Reboot")
	f.windows.verification.visible = false
	f.module.PowerMenu.request_action_confirmation("sleep")
	assert.equal(f.description.props.label(), "Confirm action")
	await tick()
})

test("confirm without a selected action does nothing and cancel hides", async () => {
	const f = await power_fixture()
	await f.confirm.props.onClicked()
	assert.deepEqual(f.log, [])
	f.cancel.props.onClicked()
	assert.deepEqual(f.log, ["verification.hide"])
	const focused: string[] = []
	f.cancel.props.$({ grab_focus: () => focused.push("cancel") })
	f.modal.props.onNotifyVisible({ visible: false })
	assert.deepEqual(focused, [])
	f.modal.props.onNotifyVisible({ visible: true })
	assert.deepEqual(focused, ["cancel"])
})
