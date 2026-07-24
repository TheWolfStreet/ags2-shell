// Shows the desktop right-click menu and handles file and icon layout actions.

import app from "ags/gtk4/app"
import { Accessor, createComputed, createState, onCleanup } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import { timeout } from "ags/time"

import Graphene from "gi://Graphene"

import { desktopController } from "../DesktopController"
import { scheduleMonitorWindowRelease } from "widget/Windowing/WindowControl"
import { desktopInteraction } from "../model/DesktopState"

const { TOP, LEFT } = Astal.WindowAnchor
const { KEY_Escape, KEY_Shift_L, KEY_Shift_R } = Gdk
const { START, END, CENTER, FILL } = Gtk.Align
const { HORIZONTAL, VERTICAL } = Gtk.Orientation

const [visible, setVisible] = createState(false)
const [monitor, setMonitor] = createState<Gdk.Monitor | null>(null)
const [monitorId, setMonitorId] = createState<string | null>(null)
const [position, setPosition] = createState({ x: 0, y: 0 })
const [shiftHeld, setShiftHeld] = createState(false)
const [desktopPointerInside, setDesktopPointerInside] = createState(false)
const [menuPointerInside, setMenuPointerInside] = createState(false)

export const desktopContextMenu = {
	visible,
	monitor,
	monitorId,
	position,
	shiftHeld,
	setShiftHeld,
	show({ monitor, monitorId, x, y, shift = false }: { monitor: Gdk.Monitor, monitorId: string, x: number, y: number, shift?: boolean }) {
		if (!desktopInteraction.enabled.peek())
			return
		setPosition({ x, y })
		setMonitor(monitor)
		setMonitorId(monitorId)
		setShiftHeld(shift)
		setMenuPointerInside(true)
		setVisible(true)
	},
	hide() {
		setVisible(false)
		setMonitor(null)
		setMonitorId(null)
		setShiftHeld(false)
		setMenuPointerInside(false)
	},
	enterDesktop() {
		setDesktopPointerInside(true)
	},
	leaveDesktop() {
		setDesktopPointerInside(false)
		desktopContextMenu.hideIfOutside()
	},
	enterMenu() {
		setMenuPointerInside(true)
	},
	leaveMenu() {
		setMenuPointerInside(false)
		desktopContextMenu.hideIfOutside()
	},
	hideIfOutside() {
		timeout(100, () => {
			if (visible.peek() && !desktopPointerInside.peek() && !menuPointerInside.peek())
				desktopContextMenu.hide()
		})
	},
}

function Action({ label, shortcut = "", visible = true, sensitive = true, run }: {
	label: string | Accessor<string>
	shortcut?: string | Accessor<string>
	visible?: boolean | Accessor<boolean>
	sensitive?: boolean | Accessor<boolean>
	run: () => void
}) {
	return (
		<button
			halign={FILL}
			hexpand
			visible={visible}
			sensitive={sensitive}
			onClicked={() => {
				run()
				desktopContextMenu.hide()
			}}
		>
			<box orientation={HORIZONTAL} hexpand>
				<label label={label} halign={START} hexpand xalign={0} />
				<label class="shortcut" label={shortcut} visible={!!shortcut} halign={END} valign={CENTER} />
			</box>
		</button>
	)
}

function MenuContent({ id, $: ref }: { id: Accessor<string>, $?: (widget: Gtk.Widget) => void }) {
	const hasSelection = desktopInteraction.selected.as(paths => paths.length > 0)
	const singleSelection = desktopInteraction.selected.as(paths => paths.length === 1)
	const canPaste = desktopInteraction.clipboard.as(payload => !!payload?.files.length)

	return (
		<box class="contents" orientation={VERTICAL} hexpand $={ref}>
			<Action label="Open" shortcut="↩" visible={singleSelection} run={() => desktopController.open(desktopInteraction.selected.peek())} />
			<Action label="Rename" shortcut="F2" visible={singleSelection} run={() => {
				const path = desktopInteraction.selected.peek()[0]
				if (path)
					desktopInteraction.rename.begin(path)
			}} />
			<Action label="Cut" shortcut="⌘X" visible={hasSelection} run={() => desktopController.cut(desktopInteraction.selected.peek())} />
			<Action label="Copy" shortcut="⌘C" visible={hasSelection} run={() => desktopController.copy(desktopInteraction.selected.peek())} />
			<Action label="Paste" shortcut="⌘V" sensitive={canPaste} run={() => { void desktopController.getGridController(id.peek()).paste() }} />
			<Action
				label={shiftHeld.as(shift => shift ? "Delete Immediately" : "Move to Trash")}
				shortcut={shiftHeld.as(shift => shift ? "⇧⌫" : "⌫")}
				visible={hasSelection}
				run={() => desktopController.remove(desktopInteraction.selected.peek(), { permanently: shiftHeld.peek() })}
			/>
			<Gtk.Separator />
			<Action label="New Folder" run={() => {
				const path = desktopController.getGridController(id.peek()).createFolder()
				if (path)
					desktopInteraction.rename.begin(path)
			}} />
		</box>
	)
}

export function DesktopContextMenu({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
	const id = createComputed(() => desktopContextMenu.monitorId() ?? "monitor:default")
	const shown = createComputed(() => desktopInteraction.enabled() && desktopContextMenu.visible() && desktopContextMenu.monitor() === gdkmonitor)
	let content: Gtk.Widget | undefined
	let window: Gtk.Window | undefined

	onCleanup(() => scheduleMonitorWindowRelease(window))

	return (
		<window
			$={self => { window = self }}
			name="desktop-context-menu"
			layer={Astal.Layer.TOP}
			exclusivity={Astal.Exclusivity.IGNORE}
			anchor={TOP | LEFT}
			application={app}
			gdkmonitor={gdkmonitor}
			visible={shown}
			keymode={Astal.Keymode.ON_DEMAND}
			marginLeft={desktopContextMenu.position.as(point => point.x)}
			marginTop={desktopContextMenu.position.as(point => point.y)}
			css="background: transparent;"
		>
			<Gtk.EventControllerKey
				onKeyPressed={(_, key) => {
					if (key === KEY_Shift_L || key === KEY_Shift_R) {
						desktopContextMenu.setShiftHeld(true)
						return false
					}
					if (key === KEY_Escape) {
						desktopContextMenu.hide()
						return true
					}
					return false
				}}
				onKeyReleased={(_, key) => {
					if (key === KEY_Shift_L || key === KEY_Shift_R)
						desktopContextMenu.setShiftHeld(false)
					return false
				}}
			/>
			<Gtk.EventControllerMotion onEnter={desktopContextMenu.enterMenu} onLeave={desktopContextMenu.leaveMenu} />
			<Gtk.GestureClick onPressed={(controller, _count, x, y) => {
				const widget = controller.get_widget()
				if (!content || !widget) {
					desktopContextMenu.hide()
					return
				}

				const [ok, bounds] = content.compute_bounds(widget)
				if (!ok || !bounds.contains_point(new Graphene.Point({ x, y })))
					desktopContextMenu.hide()
			}} />
			<MenuContent id={id} $={widget => { content = widget }} />
		</window>
	)
}
