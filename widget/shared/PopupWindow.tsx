import { createComputed, onCleanup, onMount, type Accessor } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import Graphene from "gi://Graphene"

import { is_accessor, type Props } from "$lib/ui"

import options from "$shell/options"

type vertical_position = "top" | "center" | "bottom"
type horizontal_position = "left" | "center" | "right"
export type Position = `${vertical_position}-${horizontal_position}` | "center"

export function create_popup_position(
	bar: Accessor<string>,
	popup: Accessor<string>,
): Accessor<Position> {
	return createComputed(() => {
		const vertical = bar().split("-")[0]
		const horizontal = popup().split("-").pop() ?? "center"
		return `${vertical}-${horizontal}` as Position
	})
}

const { START, END, CENTER } = Gtk.Align
const { SLIDE_UP, SLIDE_DOWN, SLIDE_LEFT, SLIDE_RIGHT, CROSSFADE } =
	Gtk.RevealerTransitionType
const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { ON_DEMAND } = Astal.Keymode
const { IGNORE } = Astal.Exclusivity
const { TOP: LAYER_TOP } = Astal.Layer
const { KEY_Escape } = Gdk

export function PopupWindow({
	name = "popup",
	class: class_name,
	layout = "center",
	transitionType: transition_type,
	decorated = false,
	visible = false,
	keymode = ON_DEMAND,
	anchor = TOP | BOTTOM | LEFT | RIGHT,
	exclusivity = IGNORE,
	layer = LAYER_TOP,
	handleClosing: handle_closing = true,
	onKey: on_key,
	onClick: on_click,
	children,
	$,
	...props
}: Props<PopupWindowImpl, popup_props> & {
	handleClosing?: boolean
	onKey?: (
		controller: Gtk.EventControllerKey,
		keyval: number,
		keycode: number,
		modifiers: number,
		window: Gtk.Window,
	) => void
	onClick?: (
		controller: Gtk.GestureClick,
		press_count: number,
		x: number,
		y: number,
		window: Gtk.Window,
		content: Gtk.Widget,
	) => void
}) {
	let content: Gtk.Revealer
	let window: PopupWindowImpl
	let visibility_unsubscribe: (() => void) | undefined

	const alignment = createComputed(() => get_position_config(layout))
	const initial_visible = is_accessor<boolean>(visible)
		? visible.peek()
		: visible
	const classes = createComputed(() => {
		const window_name = is_accessor<string>(name) ? name() : name
		const name_class = is_accessor<string>(class_name)
			? class_name()
			: class_name
		return `popup-window${window_name ? ` ${window_name}` : ""}${name_class ? ` ${name_class}` : ""}`
	})

	const pick_alignment = <K extends keyof align_config>(key: K) => {
		return alignment.as((config) => config[key])
	}

	onCleanup(() => visibility_unsubscribe?.())

	return (
		<RegisteredPopupWindow
			$={(popup_window) => {
				window = popup_window
				$?.(popup_window)
				if (is_accessor<boolean>(visible))
					visibility_unsubscribe = visible.subscribe(() =>
						popup_window.set_requested_visible(visible.peek()),
					)
			}}
			name={name}
			class={classes}
			decorated={decorated}
			visible={initial_visible}
			keymode={keymode}
			anchor={anchor}
			exclusivity={exclusivity}
			layer={layer}
			{...props}
		>
			<Gtk.EventControllerKey
				onKeyPressed={(controller, keyval, keycode, modifiers) => {
					if (handle_closing && keyval === KEY_Escape) window.hide()
					on_key?.(controller, keyval, keycode, modifiers, window)
				}}
			/>
			<Gtk.GestureClick
				onPressed={(controller, press_count, x, y) => {
					if (handle_closing && content) {
						const [valid, rect] = content.compute_bounds(window)
						if (valid && !rect.contains_point(new Graphene.Point({ x, y })))
							window.hide()
					}
					on_click?.(controller, press_count, x, y, window, content)
				}}
			/>

			<Gtk.Revealer
				transitionDuration={options.transition.duration}
				transitionType={transition_type ?? pick_alignment("transition_type")}
				halign={pick_alignment("halign")}
				valign={pick_alignment("valign")}
				onNotifyChildRevealed={(self) => {
					if (
						!self.get_child_revealed() &&
						!self.get_reveal_child() &&
						!window.requested_visible
					) {
						window.perform_hide()
					}
				}}
				$={(self) => {
					onMount(() => {
						content = self
						window.revealer = self
						if (window.get_visible()) {
							self.set_opacity(1)
							self.get_child()?.set_opacity(1)
							self.set_reveal_child(true)
						}
					})
				}}
			>
				{children}
			</Gtk.Revealer>
		</RegisteredPopupWindow>
	)
}

type align_config = {
	halign: Gtk.Align
	valign: Gtk.Align
	transition_type: Gtk.RevealerTransitionType
}

const position_config: Record<Position, align_config> = {
	center: { halign: CENTER, valign: CENTER, transition_type: CROSSFADE },
	"top-left": { halign: START, valign: START, transition_type: SLIDE_DOWN },
	"top-center": { halign: CENTER, valign: START, transition_type: SLIDE_DOWN },
	"top-right": { halign: END, valign: START, transition_type: SLIDE_DOWN },
	"center-left": {
		halign: START,
		valign: CENTER,
		transition_type: SLIDE_RIGHT,
	},
	"center-center": {
		halign: CENTER,
		valign: CENTER,
		transition_type: CROSSFADE,
	},
	"center-right": { halign: END, valign: CENTER, transition_type: SLIDE_LEFT },
	"bottom-left": { halign: START, valign: END, transition_type: SLIDE_UP },
	"bottom-center": { halign: CENTER, valign: END, transition_type: SLIDE_UP },
	"bottom-right": { halign: END, valign: END, transition_type: SLIDE_UP },
}

function is_position(value: unknown): value is Position {
	return (
		typeof value === "string" &&
		Object.prototype.hasOwnProperty.call(position_config, value)
	)
}

function get_position_config(value: unknown): align_config {
	if (is_accessor<unknown>(value)) return get_position_config(value())
	return is_position(value) ? position_config[value] : position_config.center
}

interface popup_props extends Astal.Window.ConstructorProps {
	children: JSX.Element | Array<JSX.Element>
	layout?: Position | Accessor<Position>
	transitionType?: Gtk.RevealerTransitionType
}

class PopupWindowImpl extends Astal.Window {
	revealer?: Gtk.Revealer
	declare requested_visible: boolean

	set_requested_visible(visible: boolean) {
		this.requested_visible = visible
		if (visible) {
			this.show()
			this.reset_revealer_opacity()
			this.revealer?.set_reveal_child(true)
		} else {
			this.hide()
		}
	}

	private reset_revealer_opacity() {
		if (!this.revealer) return
		this.revealer.set_opacity(1)
		const child = this.revealer.get_child()
		child?.set_opacity(1)
	}

	override vfunc_show() {
		this.requested_visible = true
		super.vfunc_show()
		this.reset_revealer_opacity()
		this.revealer?.set_reveal_child(true)
	}

	override vfunc_hide() {
		this.requested_visible = false
		this.revealer?.set_reveal_child(false)
		if (!this.revealer || !this.revealer.get_mapped()) this.perform_hide()
	}

	perform_hide() {
		super.vfunc_hide()
		this.notify("visible")
	}
}

const RegisteredPopupWindow = GObject.registerClass(PopupWindowImpl)
