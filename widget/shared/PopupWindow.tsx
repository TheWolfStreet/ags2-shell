import {
	createComputed,
	createState,
	onCleanup,
	onMount,
	type Accessor,
} from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import Graphene from "gi://Graphene"

import {
	is_accessor,
	peek_value,
	read_value,
	type maybe_accessor,
	type props,
} from "$lib/ui"

import options from "$shell/options"

type vertical_position = "top" | "center" | "bottom"
type horizontal_position = "left" | "center" | "right"
export type position = `${vertical_position}-${horizontal_position}` | "center"

export function create_popup_position(
	bar: Accessor<string>,
	popup: Accessor<string>,
): Accessor<position> {
	return createComputed(() => {
		const vertical = bar().split("-")[0]
		const horizontal = popup().split("-").pop() ?? "center"
		return `${vertical}-${horizontal}` as position
	})
}

const { START, END, CENTER } = Gtk.Align
const { SLIDE_UP, SLIDE_DOWN, SLIDE_LEFT, SLIDE_RIGHT, CROSSFADE } =
	Gtk.RevealerTransitionType
const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { ON_DEMAND } = Astal.Keymode
const { IGNORE } = Astal.Exclusivity
const { TOP: layer_top, OVERLAY: layer_overlay } = Astal.Layer
const { KEY_Escape } = Gdk

const [bar_thickness, set_bar_thickness] = createState(0)

export { bar_thickness, set_bar_thickness }

function bar_attachment() {
	const bar_on_top = options.bar.position.as((value) => value === "top-center")
	return {
		exclusivity: IGNORE,
		layer: layer_overlay,
		marginTop: createComputed(() => (bar_on_top() ? bar_thickness() : 0)),
		marginBottom: createComputed(() => (bar_on_top() ? 0 : bar_thickness())),
	}
}

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
	layer = layer_top,
	handle_closing = true,
	attach_to_bar = false,
	onKey: on_key,
	children,
	$,
	...props
}: props<PopupWindowImpl, popup_props> & {
	handle_closing?: boolean
	attach_to_bar?: boolean
	onKey?: (
		controller: Gtk.EventControllerKey,
		keyval: number,
		keycode: number,
		modifiers: number,
		window: Gtk.Window,
	) => void
}) {
	let content: Gtk.Revealer
	let window: PopupWindowImpl
	let visibility_unsubscribe: (() => void) | undefined

	const alignment = createComputed(() =>
		get_position_config(read_value(layout)),
	)
	const initial_visible = peek_value(visible)
	const classes = createComputed(() =>
		["popup-window", read_value(name), read_value(class_name)]
			.filter(Boolean)
			.join(" "),
	)

	const pick_alignment = <K extends keyof align_config>(key: K) =>
		alignment.as((config) => config[key])

	onCleanup(() => {
		visibility_unsubscribe?.()
		window?.perform_hide()
	})

	function close_on_outside_click(x: number, y: number) {
		if (!handle_closing || !content) return
		const [valid, rect] = content.compute_bounds(window)
		if (!valid || rect.contains_point(new Graphene.Point({ x, y }))) return
		window.hide()
	}

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
			{...(attach_to_bar ? bar_attachment() : {})}
			{...props}
		>
			<Gtk.EventControllerKey
				onKeyPressed={(controller, keyval, keycode, modifiers) => {
					if (handle_closing && keyval === KEY_Escape) window.hide()
					on_key?.(controller, keyval, keycode, modifiers, window)
				}}
			/>
			<Gtk.GestureClick
				onPressed={(_controller, _press_count, x, y) =>
					close_on_outside_click(x, y)
				}
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
					)
						window.perform_hide()
				}}
				$={(self) => {
					onMount(() => {
						content = self
						window.revealer = self
						if (window.get_visible()) window.reveal_content()
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

const position_config: Record<position, align_config> = {
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

function is_position(value: unknown): value is position {
	return (
		typeof value === "string" &&
		Object.prototype.hasOwnProperty.call(position_config, value)
	)
}

function get_position_config(value: unknown): align_config {
	if (!is_position(value)) return position_config.center
	return position_config[value]
}

type popup_props = Astal.Window.ConstructorProps & {
	children: JSX.Element | Array<JSX.Element>
	layout?: maybe_accessor<position>
	transitionType?: Gtk.RevealerTransitionType
}

class PopupWindowImpl extends Astal.Window {
	revealer?: Gtk.Revealer
	declare requested_visible: boolean

	set_requested_visible(visible: boolean) {
		this.requested_visible = visible
		if (!visible) {
			this.hide()
			return
		}
		this.show()
		this.reveal_content()
	}

	reveal_content() {
		if (!this.revealer) return
		this.revealer.set_opacity(1)
		this.revealer.get_child()?.set_opacity(1)
		this.revealer.set_reveal_child(true)
	}

	override vfunc_show() {
		this.requested_visible = true
		super.vfunc_show()
		this.reveal_content()
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
