import app from "$lib/app"
import { Accessor, createComputed, createState, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { idle, timeout } from "$lib/time"

import Graphene from "gi://Graphene"

import { schedule_monitor_window_release } from "$lib/windowing"
import options from "$shell/options"
import {
	copy_desktop_files,
	create_desktop_entry,
	cut_desktop_files,
	desktop_file_by_path,
	desktop_interaction,
	open_desktop_files,
	paste_desktop_files,
	remove_desktop_files,
} from "../Desktop"
import { DesktopLauncherCreator } from "./LauncherCreator"
import { DesktopOpenWith } from "./OpenWith"

const { TOP, LEFT } = Astal.WindowAnchor
const { KEY_Escape, KEY_Shift_L, KEY_Shift_R } = Gdk
const { START, END, CENTER, FILL } = Gtk.Align
const { HORIZONTAL, VERTICAL } = Gtk.Orientation

const [visible, set_visible] = createState(false)
const [monitor, set_monitor] = createState<Gdk.Monitor | null>(null)
const [monitor_id, set_monitor_id] = createState<string | null>(null)
const [position, set_position] = createState({ x: 0, y: 0 })
const [shift_held, set_shift_held] = createState(false)
const [desktop_pointer_inside, set_desktop_pointer_inside] = createState(false)
const [menu_pointer_inside, set_menu_pointer_inside] = createState(false)
const context_windows = new Map<Gdk.Monitor, Gtk.Window>()

export const desktop_context_menu = {
	visible,
	monitor,
	monitor_id,
	position,
	shift_held,
	set_shift_held,
	show({
		monitor,
		monitor_id,
		x,
		y,
		shift = false,
	}: {
		monitor: Gdk.Monitor
		monitor_id: string
		x: number
		y: number
		shift?: boolean
	}) {
		if (!options.desktop.enabled.peek()) return
		set_position({ x, y })
		set_monitor(monitor)
		set_monitor_id(monitor_id)
		set_shift_held(shift)
		set_menu_pointer_inside(true)
		set_visible(true)
	},
	hide() {
		set_visible(false)
		set_monitor(null)
		set_monitor_id(null)
		set_shift_held(false)
		set_menu_pointer_inside(false)
	},
	hide_then(run: () => void) {
		const active_monitor = monitor.peek()
		const window = active_monitor ? context_windows.get(active_monitor) : null
		if (!window?.get_visible()) {
			desktop_context_menu.hide()
			idle(run)
			return
		}

		let handler = 0
		handler = window.connect("notify::visible", (self) => {
			if (self.get_visible()) return
			self.disconnect(handler)
			idle(run)
		})
		desktop_context_menu.hide()
	},
	enter_desktop() {
		set_desktop_pointer_inside(true)
	},
	leave_desktop() {
		set_desktop_pointer_inside(false)
		desktop_context_menu.hide_if_outside()
	},
	enter_menu() {
		set_menu_pointer_inside(true)
	},
	leave_menu() {
		set_menu_pointer_inside(false)
		desktop_context_menu.hide_if_outside()
	},
	hide_if_outside() {
		timeout(100, () => {
			if (
				visible.peek() &&
				!desktop_pointer_inside.peek() &&
				!menu_pointer_inside.peek()
			)
				desktop_context_menu.hide()
		})
	},
}

function Action({
	label,
	shortcut = "",
	visible = true,
	run,
}: {
	label: string | Accessor<string>
	shortcut?: string | Accessor<string>
	visible?: boolean | Accessor<boolean>
	run: () => void | Promise<void>
}) {
	return (
		<button
			halign={FILL}
			hexpand
			visible={visible}
			onClicked={() => {
				try {
					const outcome = run()
					if (outcome instanceof Promise)
						void outcome.catch((error) =>
							console.error("desktop.menu: Action failed", error))
				} catch (error) {
					console.error("desktop.menu: Action failed", error)
				} finally {
					desktop_context_menu.hide()
				}
			}}
		>
			<box orientation={HORIZONTAL} hexpand>
				<label label={label} halign={START} hexpand xalign={0} />
				<label
					class="shortcut"
					label={shortcut}
					visible={!!shortcut}
					halign={END}
					valign={CENTER}
				/>
			</box>
		</button>
	)
}

function MenuContent({
	id,
	$: ref,
}: {
	id: Accessor<string>
	$?: (widget: Gtk.Widget) => void
}) {
	const has_selection = desktop_interaction.selected.as(
		(paths) => paths.length > 0,
	)
	const single_selection = desktop_interaction.selected.as(
		(paths) => paths.length === 1,
	)
	const background_menu = desktop_interaction.selected.as(
		(paths) => paths.length === 0,
	)
	const open_with_visible = createComputed(() => {
		const paths = desktop_interaction.selected()
		if (paths.length !== 1) return false
		const selected = desktop_file_by_path(paths[0])
		return !!selected && selected.contentType !== "inode/directory"
	})

	return (
		<box class="contents" orientation={VERTICAL} hexpand $={ref}>
			<Action
				label="Open"
				shortcut="↩"
				visible={single_selection}
				run={() => open_desktop_files(desktop_interaction.selected.peek())}
			/>
			<Action
				label="Open With…"
				visible={open_with_visible}
				run={() => {
					const path = desktop_interaction.selected.peek()[0]
					if (path) DesktopOpenWith.open(path)
				}}
			/>
			<Action
				label="Rename"
				shortcut="F2"
				visible={single_selection}
				run={() => {
					const path = desktop_interaction.selected.peek()[0]
					if (path) desktop_interaction.rename.begin(path)
				}}
			/>
			<Action
				label="Cut"
				shortcut="Ctrl+X"
				visible={has_selection}
				run={() => cut_desktop_files(desktop_interaction.selected.peek())}
			/>
			<Action
				label="Copy"
				shortcut="Ctrl+C"
				visible={has_selection}
				run={() => copy_desktop_files(desktop_interaction.selected.peek())}
			/>
			<Action
				label="Paste"
				shortcut="Ctrl+V"
				run={() => paste_desktop_files(id.peek())}
			/>
			<Action
				label={shift_held.as((shift) =>
					shift ? "Delete Immediately" : "Move to Trash",
				)}
				shortcut={shift_held.as((shift) => (shift ? "⇧⌫" : "⌫"))}
				visible={has_selection}
				run={() =>
					remove_desktop_files(desktop_interaction.selected.peek(), {
						permanently: shift_held.peek(),
					})
				}
			/>
			<Gtk.Separator visible={background_menu} />
			<Action
				label="New Launcher"
				visible={background_menu}
				run={() => DesktopLauncherCreator.open(id.peek())}
			/>
			<Action
				label="New Folder"
				visible={background_menu}
				run={() => {
					const path = create_desktop_entry(id.peek(), { kind: "folder" })
					if (path)
						desktop_context_menu.hide_then(() =>
							desktop_interaction.rename.begin(path),
						)
				}}
			/>
			<Action
				label="New Text File"
				visible={background_menu}
				run={() => {
					const path = create_desktop_entry(id.peek(), { kind: "file" })
					if (path)
						desktop_context_menu.hide_then(() =>
							desktop_interaction.rename.begin(path),
						)
				}}
			/>
		</box>
	)
}

export function DesktopContextMenu({
	gdkmonitor,
}: {
	gdkmonitor: Gdk.Monitor
}) {
	const id = createComputed(
		() => desktop_context_menu.monitor_id() ?? "monitor:default",
	)
	const shown = createComputed(
		() =>
			options.desktop.enabled() &&
			desktop_context_menu.visible() &&
			desktop_context_menu.monitor() === gdkmonitor,
	)
	let content: Gtk.Widget | undefined
	let window: Gtk.Window | undefined

	onCleanup(() => {
		if (window && context_windows.get(gdkmonitor) === window)
			context_windows.delete(gdkmonitor)
		schedule_monitor_window_release(window)
	})

	return (
		<window
			$={(self) => {
				window = self
				context_windows.set(gdkmonitor, self)
			}}
			name="desktop-context-menu"
			layer={Astal.Layer.TOP}
			exclusivity={Astal.Exclusivity.IGNORE}
			anchor={TOP | LEFT}
			application={app}
			gdkmonitor={gdkmonitor}
			visible={shown}
			keymode={Astal.Keymode.ON_DEMAND}
			marginLeft={desktop_context_menu.position.as((point) => point.x)}
			marginTop={desktop_context_menu.position.as((point) => point.y)}
			css="background: transparent;"
		>
			<Gtk.EventControllerKey
				onKeyPressed={(unused, key) => {
					if (key === KEY_Shift_L || key === KEY_Shift_R) {
						desktop_context_menu.set_shift_held(true)
						return false
					}
					if (key === KEY_Escape) {
						desktop_context_menu.hide()
						return true
					}
					return false
				}}
				onKeyReleased={(unused, key) => {
					if (key === KEY_Shift_L || key === KEY_Shift_R)
						desktop_context_menu.set_shift_held(false)
					return false
				}}
			/>
			<Gtk.EventControllerMotion
				onEnter={desktop_context_menu.enter_menu}
				onLeave={desktop_context_menu.leave_menu}
			/>
			<Gtk.GestureClick
				onPressed={(controller, count, x, y) => {
					const widget = controller.get_widget()
					if (!content || !widget) {
						desktop_context_menu.hide()
						return
					}

					const [ok, bounds] = content.compute_bounds(widget)
					if (!ok || !bounds.contains_point(new Graphene.Point({ x, y })))
						desktop_context_menu.hide()
				}}
			/>
			<MenuContent
				id={id}
				$={(widget) => {
					content = widget
				}}
			/>
		</window>
	)
}
