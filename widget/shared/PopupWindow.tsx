import { onMount } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import Graphene from "gi://Graphene"

import { Props, type Position } from "$lib/utils"

import options from "options"

const { START, END, CENTER } = Gtk.Align
const { SLIDE_UP, SLIDE_DOWN, SLIDE_LEFT, SLIDE_RIGHT, CROSSFADE } = Gtk.RevealerTransitionType
const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
const { ON_DEMAND } = Astal.Keymode
const { IGNORE } = Astal.Exclusivity
const { TOP: LAYER_TOP } = Astal.Layer
const { KEY_Escape } = Gdk

export function PopupWindow({
	name = "popup",
	class: className,
	layout = "center",
	transitionType,
	decorated = false,
	visible = false,
	keymode = ON_DEMAND,
	anchor = TOP | BOTTOM | LEFT | RIGHT,
	exclusivity = IGNORE,
	layer = LAYER_TOP,
	handleClosing = true,
	onKey,
	onClick,
	children,
	$,
	...props
}: Props<Impl, PopupProps> & {
	handleClosing?: boolean
	onKey?: (ctrl: Gtk.EventControllerKey, keyval: number, code: number, mod: number, w: Gtk.Window) => void
	onClick?: (ctrl: Gtk.GestureClick, n: number, x: number, y: number, w: Gtk.Window, content: Gtk.Widget) => void
}) {
	let content: Gtk.Revealer
	let win: Impl

	const alignment = typeof layout === "function"
		? (layout as import("ags").Accessor<Position>).as(p => POSITION_CONFIG[p])
		: POSITION_CONFIG[layout ?? "center"]

	const isAccessor = typeof alignment === "function"
	const pickAlignment = <K extends keyof AlignConfig>(key: K) => {
		if (isAccessor)
			return (alignment as import("ags").Accessor<AlignConfig>).as(v => v[key])

		return (alignment as AlignConfig)[key]
	}

	return (
		<Popup
			$={w => {
				win = w
				$ && $(w)
			}}
			name={name}
			class={`${name && name + " "}${className}`}
			decorated={decorated}
			visible={visible}
			keymode={keymode}
			anchor={anchor}
			exclusivity={exclusivity}
			layer={layer}
			{...props}
		>
			<Gtk.EventControllerKey onKeyPressed={(ctrl, keyval, code, mod) => handleClosing && onKeyHandler(ctrl, keyval, code, mod, win, onKey)} />
			<Gtk.GestureClick onPressed={(ctrl, n, x, y) => handleClosing && onClickHandler(ctrl, n, x, y, win, content, onClick)} />

			<Gtk.Revealer
				transitionDuration={options.transition.duration}
				transitionType={transitionType ?? pickAlignment("transitionType")}
				halign={pickAlignment("halign")}
				valign={pickAlignment("valign")}
				onNotifyChildRevealed={(self) => {
					if (!self.get_child_revealed() && !self.get_reveal_child()) {
						win.performHide()
					}
				}}
				$={self => {
					onMount(() => {
						content = self
						win.revealer = self
						if (win.get_visible()) {
							self.set_opacity(1)
							self.get_child()?.set_opacity(1)
							self.set_reveal_child(true)
						}
					})
				}}
			>
				{children}
			</Gtk.Revealer>
		</Popup>
	)
}

export type { Position }

function onKeyHandler(
	ctrl: Gtk.EventControllerKey,
	keyval: number,
	code: number,
	mod: number,
	w: Gtk.Window,
	onKey?: (ctrl: Gtk.EventControllerKey, keyval: number, code: number, mod: number, w: Gtk.Window) => void
) {
	if (keyval === KEY_Escape) w.hide()
	if (onKey) onKey(ctrl, keyval, code, mod, w)
}

function onClickHandler(
	ctrl: Gtk.GestureClick,
	n: number,
	x: number,
	y: number,
	w: Gtk.Window,
	content: Gtk.Widget,
	onClick?: (ctrl: Gtk.GestureClick, n: number, x: number, y: number, w: Gtk.Window, content: Gtk.Widget) => void
) {
	const [, rect] = content.compute_bounds(w)
	const point = new Graphene.Point({ x, y })
	if (!rect.contains_point(point)) w.hide()
	if (onClick) onClick(ctrl, n, x, y, w, content)
}

type AlignConfig = {
	halign: Gtk.Align
	valign: Gtk.Align
	transitionType: Gtk.RevealerTransitionType
}

const POSITION_CONFIG: Record<Position, AlignConfig> = {
	"center": { halign: CENTER, valign: CENTER, transitionType: CROSSFADE },
	"top-left": { halign: START, valign: START, transitionType: SLIDE_DOWN },
	"top-center": { halign: CENTER, valign: START, transitionType: SLIDE_DOWN },
	"top-right": { halign: END, valign: START, transitionType: SLIDE_DOWN },
	"center-left": { halign: START, valign: CENTER, transitionType: SLIDE_RIGHT },
	"center-center": { halign: CENTER, valign: CENTER, transitionType: CROSSFADE },
	"center-right": { halign: END, valign: CENTER, transitionType: SLIDE_LEFT },
	"bottom-left": { halign: START, valign: END, transitionType: SLIDE_UP },
	"bottom-center": { halign: CENTER, valign: END, transitionType: SLIDE_UP },
	"bottom-right": { halign: END, valign: END, transitionType: SLIDE_UP },
}

interface PopupProps extends Astal.Window.ConstructorProps {
	children: JSX.Element | Array<JSX.Element>
	layout?: Position | import("ags").Accessor<Position>
	transitionType?: Gtk.RevealerTransitionType
}

class Impl extends Astal.Window {
	revealer?: Gtk.Revealer

	private resetRevealerOpacity() {
		if (!this.revealer) return
		this.revealer.set_opacity(1)
		const child = this.revealer.get_child()
		child?.set_opacity(1)
	}

	override vfunc_show() {
		super.vfunc_show()
		this.resetRevealerOpacity()
		this.revealer?.set_reveal_child(true)
	}

	override vfunc_hide() {
		this.revealer?.set_reveal_child(false)
	}

	performHide() {
		super.vfunc_hide()
		this.notify("visible")
	}
}

const Popup = GObject.registerClass(Impl)
