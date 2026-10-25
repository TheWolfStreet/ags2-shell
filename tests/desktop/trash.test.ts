import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { load_module } from "../load_module.ts"
import { with_hyprland_command } from "../hyprland.ts"
import * as result from "../../lib/result.ts"
import { tick } from "../helpers.ts"

const open_failure = "dock.trash.open: Failed to open or focus trash"
const refresh_failure = "dock.trash.refresh: Failed to refresh trash state"

type fake_trash = {
	open_error?: Error
	next_error?: Error
	close_error?: Error
	close_result?: boolean
	items?: number
	monitor_error?: Error
}

type fake_client = ReturnType<typeof client>

async function fixture({
	id = "org.gnome.Nautilus.desktop",
	executable = "/usr/bin/nautilus",
	wm_class = "Nautilus",
	clients = [],
	focused_workspace = 3,
	launch_result = true,
	trash = {},
}: {
	id?: string | null
	executable?: string | null
	wm_class?: string | null
	clients?: fake_client[]
	focused_workspace?: number | null
	launch_result?: boolean
	trash?: fake_trash
} = {}) {
	const calls: [string, ...any[]][] = []
	const errors: [string, unknown][] = []
	const has_items_values: boolean[] = []
	const monitors: { cancelled: number; changed?: () => void }[] = []
	const refresh = { calls: 0, cancels: 0, run: async () => {} }
	const hyprland = {
		clients,
		focusedWorkspace:
			focused_workspace == null ? null : { id: focused_workspace },
	}
	const app =
		id || executable
			? { get_id: () => id, get_executable: () => executable }
			: null
	let move = async (workspace, client) => {
		calls.push(["move", workspace, client.get_address()])
		return result.ok(undefined)
	}
	const imports = {
		ags: {
			createState: (value) => [
				() => value,
				(next) => has_items_values.push(next),
			],
		},
		"gi://Gio": {
			default: {
				FileQueryInfoFlags: { NONE: 0 },
				FileMonitorFlags: { WATCH_MOVES: 8 },
				File: { new_for_uri: () => trash_directory(trash, calls, monitors) },
				AppInfo: {
					get_default_for_type: (type, must_support_uris) => {
						calls.push(["default", type, must_support_uris])
						return app
					},
				},
				app_info_launch_default_for_uri: (uri) => {
					calls.push(["launch", uri])
					return launch_result
				},
			},
		},
		"gi://GioUnix": {
			default: {
				DesktopAppInfo: {
					new: () => ({ get_startup_wm_class: () => wm_class }),
				},
			},
		},
		"gi://GLib": { default: { PRIORITY_DEFAULT: 0 } },
		"$lib/hyprland": with_hyprland_command({ hyprland }),
		"$lib/time": {
			debounce: (_ms, fn) => {
				refresh.run = fn
				return {
					call: () => refresh.calls++,
					cancel: () => refresh.cancels++,
				}
			},
		},
		"$lib/windowing": {
			focus_client: async (target) => {
				target.focus()
				return result.ok(undefined)
			},
			get_client_workspace_id: (client) => client.workspace?.id ?? null,
			move_client_to_workspace_silent: (...args: Parameters<typeof move>) =>
				move(...args),
		},
	}
	const trash_module = await load_module(
		"widget/Dock/components/trash.tsx",
		imports,
	)
	mock.method(console, "error", (tag: string, error: unknown) => {
		if (!String(tag).includes("ExperimentalWarning")) errors.push([tag, error])
	})
	return {
		calls,
		errors,
		has_items_values,
		monitors,
		refresh,
		acquire: trash_module.acquire_trash_watcher as () => () => void,
		click: trash_module.open_trash as () => void,
		open: async () => {
			trash_module.open_trash()
			await tick()
			return errors.filter(([tag]) => tag === open_failure)
		},
		read_trash: async () => {
			const release = trash_module.acquire_trash_watcher()
			await tick()
			release()
			const failures = errors.filter(([tag]) => tag === refresh_failure)
			if (failures.length) return { ok: false, err: failures[0][1] }
			return { ok: true, value: has_items_values.at(-1) }
		},
		set_move: (fn) => {
			move = fn
		},
	}
}

function trash_directory(
	trash: fake_trash,
	calls: [string, ...any[]][],
	monitors: { cancelled: number; changed?: () => void }[],
) {
	return {
		enumerate_children_async: async () => {
			if (trash.open_error) throw trash.open_error
			return {
				next_files_async: async () => {
					calls.push(["next"])
					if (trash.next_error) throw trash.next_error
					return Array.from({ length: trash.items ?? 0 }, () => ({}))
				},
				close_async: async () => {
					calls.push(["close"])
					if (trash.close_error) throw trash.close_error
					return trash.close_result ?? true
				},
			}
		},
		monitor_directory: (flags) => {
			if (trash.monitor_error) throw trash.monitor_error
			const monitor: { cancelled: number; changed?: () => void } = {
				cancelled: 0,
			}
			monitors.push(monitor)
			calls.push(["monitor", flags])
			return {
				connect: (signal, callback) => {
					assert.equal(signal, "changed")
					monitor.changed = callback
				},
				cancel: () => monitor.cancelled++,
			}
		},
	}
}

function client(title, class_name, workspace = 2) {
	let address = "abc"
	let focuses = 0
	return {
		get_title: () => title,
		get_class: () => class_name,
		workspace: { id: workspace },
		get_address: () => address,
		set_address: (value) => {
			address = value
		},
		focus: () => {
			focuses++
		},
		focuses: () => focuses,
	}
}

test.afterEach(() => mock.restoreAll())

test("browser tab titled Trash is never moved or focused", async () => {
	const browser = client("Trash", "firefox")
	const f = await fixture({ clients: [browser] })
	assert.deepEqual(await f.open(), [])
	assert.deepEqual(f.calls.at(-1), ["launch", "trash:///"])
	assert.equal(browser.focuses(), 0)
})

test("default Nautilus Trash window moves to focused workspace before focusing", async () => {
	const window = client("Trash", "org.gnome.Nautilus")
	const f = await fixture({ clients: [window] })
	assert.deepEqual(await f.open(), [])
	assert.deepEqual(f.calls, [
		["default", "inode/directory", false],
		["move", 3, "abc"],
	])
	assert.equal(window.focuses(), 1)
})

test("Trash window already on the focused workspace is focused without moving", async () => {
	const window = client("Trash", "nautilus", 3)
	const f = await fixture({ clients: [window] })
	assert.deepEqual(await f.open(), [])
	assert.deepEqual(f.calls, [["default", "inode/directory", false]])
	assert.equal(window.focuses(), 1)
})

test("StartupWMClass and executable basename identify the selected file manager", async () => {
	for (const [id, executable, wm_class, class_name] of [
		["org.kde.dolphin.desktop", "/usr/bin/dolphin", "dolphin", "dolphin"],
		[null, "/usr/bin/nautilus", null, "nautilus"],
		["org.kde.files.desktop", null, "DolphinFM", "dolphinfm"],
	]) {
		const window = client("Trash", class_name)
		const f = await fixture({ id, executable, wm_class, clients: [window] })
		assert.deepEqual(await f.open(), [])
		assert.equal(window.focuses(), 1)
		assert.deepEqual(f.calls.at(-1), ["move", 3, "abc"])
		assert.equal(
			f.calls.some(([kind]) => kind === "launch"),
			false,
		)
	}
})

test("partial title and unmatched manager do not reuse a folder window", async () => {
	const folder = client("Trash project", "org.gnome.Nautilus")
	const other = client("Trash", "dolphin")
	const f = await fixture({ clients: [folder, other] })
	assert.deepEqual(await f.open(), [])
	assert.deepEqual(f.calls.at(-1), ["launch", "trash:///"])
	assert.equal(folder.focuses() + other.focuses(), 0)
})

test("missing identity or focused workspace falls back without moving a client", async () => {
	const window = client("Trash", "Nautilus")
	const missing = await fixture({
		id: null,
		executable: null,
		clients: [window],
	})
	assert.deepEqual(await missing.open(), [])
	assert.deepEqual(missing.calls.at(-1), ["launch", "trash:///"])
	mock.restoreAll()
	const no_workspace = await fixture({
		clients: [window],
		focused_workspace: null,
	})
	assert.deepEqual(await no_workspace.open(), [])
	assert.equal(
		no_workspace.calls.some(([kind]) => kind === "move"),
		false,
	)
	assert.deepEqual(no_workspace.calls.at(-1), ["launch", "trash:///"])
	assert.equal(window.focuses(), 0)
})

test("awaits a dynamic-address move result before focusing and reports failure", async () => {
	const window = client("Trash", "Nautilus")
	const f = await fixture({ clients: [window] })
	let finish_move
	f.set_move(async (workspace, target) => {
		f.calls.push(["move", workspace, target.get_address()])
		return new Promise((resolve) => {
			finish_move = resolve
		})
	})
	window.set_address("new-address")
	f.click()
	await tick()
	assert.deepEqual(f.calls.at(-1), ["move", 3, "new-address"])
	assert.equal(window.focuses(), 0)
	const rejected = new Error("move rejected")
	finish_move(result.err(rejected))
	await tick()
	assert.deepEqual(f.errors, [[open_failure, rejected]])
	assert.equal(window.focuses(), 0)
})

test("click remains fire-and-forget and logs launch failure", async () => {
	const f = await fixture({ launch_result: false })
	assert.equal(f.click(), undefined)
	await tick()
	assert.equal(f.errors.length, 1)
	assert.equal(f.errors[0][0], open_failure)
	assert.match(
		(f.errors[0][1] as Error).message,
		/No application could open Trash/,
	)
})

test("launch exceptions are reported as open failures", async () => {
	const f = await fixture()
	const thrown = new Error("no handler")
	const original = f.calls.push.bind(f.calls)
	f.calls.push = (...entries) => {
		if (entries[0][0] === "launch") throw thrown
		return original(...entries)
	}
	f.click()
	await tick()
	assert.deepEqual(f.errors, [[open_failure, thrown]])
})

test("trash state reads one item and always closes the enumeration", async () => {
	const empty = await fixture()
	assert.deepEqual(await empty.read_trash(), { ok: true, value: false })
	mock.restoreAll()
	const full = await fixture({ trash: { items: 1 } })
	assert.deepEqual(await full.read_trash(), { ok: true, value: true })
	assert.deepEqual(full.calls, [["monitor", 8], ["next"], ["close"]])
})

test("trash state reports enumeration failures in finally order", async () => {
	const opened = new Error("no trash backend")
	const open_failed = await fixture({ trash: { open_error: opened } })
	assert.deepEqual(await open_failed.read_trash(), { ok: false, err: opened })
	assert.deepEqual(open_failed.calls, [["monitor", 8]])
	assert.deepEqual(open_failed.has_items_values, [])
	mock.restoreAll()

	const next = new Error("enumeration failed")
	const next_failed = await fixture({ trash: { next_error: next } })
	assert.deepEqual(await next_failed.read_trash(), { ok: false, err: next })
	assert.deepEqual(next_failed.calls, [["monitor", 8], ["next"], ["close"]])
	mock.restoreAll()

	const closed = new Error("close failed")
	const close_failed = await fixture({
		trash: { next_error: next, close_error: closed },
	})
	assert.deepEqual(await close_failed.read_trash(), { ok: false, err: closed })
	mock.restoreAll()

	const close_false = await fixture({
		trash: { items: 1, close_result: false },
	})
	const closed_false = await close_false.read_trash()
	assert.equal(closed_false.ok, false)
	assert.equal(
		(closed_false.err as Error).message,
		"Failed to close Trash enumeration",
	)
	mock.restoreAll()

	const both_false = await fixture({
		trash: { next_error: next, close_result: false },
	})
	const both = await both_false.read_trash()
	assert.equal((both.err as Error).message, "Failed to close Trash enumeration")
})

test("the watcher is shared, refreshes on change and stops with its last user", async () => {
	const f = await fixture({ trash: { items: 1 } })
	const release_first = f.acquire()
	const release_second = f.acquire()
	await tick()
	assert.equal(f.monitors.length, 1)
	assert.deepEqual(f.has_items_values, [true])
	f.monitors[0].changed!()
	assert.equal(f.refresh.calls, 1)
	release_first()
	assert.equal(f.monitors[0].cancelled, 0)
	assert.equal(f.refresh.cancels, 0)
	release_second()
	assert.equal(f.monitors[0].cancelled, 1)
	assert.equal(f.refresh.cancels, 1)
	release_second()
	assert.equal(f.monitors[0].cancelled, 1)
	assert.equal(f.refresh.cancels, 2)
	f.acquire()
	assert.equal(f.monitors.length, 2)
})

test("a refresh finishing after the last release does not publish state", async () => {
	const f = await fixture({ trash: { items: 1 } })
	const release = f.acquire()
	release()
	await tick()
	assert.deepEqual(f.has_items_values, [])
	f.acquire()
	await f.refresh.run()
	assert.deepEqual(f.has_items_values, [true, true])
})

test("a failing directory monitor is logged and still refreshes once", async () => {
	const failure = new Error("no monitor")
	const f = await fixture({ trash: { monitor_error: failure } })
	f.acquire()
	await tick()
	assert.deepEqual(f.errors, [
		["dock.trash.watch: Failed to watch trash:///", failure],
	])
	assert.deepEqual(f.has_items_values, [false])
})
