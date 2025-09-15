import { Node, onMount } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import Graphene from "gi://Graphene"

import { Props } from "$lib/utils"

import options from "options"

const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

export type Position =
	'center' | 'top' | 'top-right' | 'top-center' | 'top-left' |
	'bottom-left' | 'bottom-center' | 'bottom-right'

function onKeyHandler(
	ctrl: Gtk.EventControllerKey,
	keyval: number,
	code: number,
	mod: number,
	w: Gtk.Window,
	onKey?: (ctrl: Gtk.EventControllerKey, keyval: number, code: number, mod: number, w: Gtk.Window) => void
) {
	if (keyval === Gdk.KEY_Escape) w.hide()
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

function getPosConfig(pos: Position) {
	const { START, END, CENTER } = Gtk.Align
	const { SLIDE_UP, SLIDE_DOWN, CROSSFADE } = Gtk.RevealerTransitionType

	switch (pos) {
		case 'top-left': return { halign: START, valign: START, transitionType: SLIDE_DOWN }
		case 'top-center': return { halign: CENTER, valign: START, transitionType: SLIDE_DOWN }
		case 'top-right': return { halign: END, valign: START, transitionType: SLIDE_DOWN }
		case 'center': return { halign: CENTER, valign: CENTER, transitionType: CROSSFADE }
		case 'bottom-left': return { halign: START, valign: END, transitionType: SLIDE_UP }
		case 'bottom-center': return { halign: CENTER, valign: END, transitionType: SLIDE_UP }
		case 'bottom-right': return { halign: END, valign: END, transitionType: SLIDE_UP }
		default: return { halign: CENTER, valign: CENTER, transitionType: CROSSFADE }
	}
}

interface PopupWindowProps extends Astal.Window.ConstructorProps {
	children: Node | Node[]
	layout: Position
	transitionType: Gtk.RevealerTransitionType
}

class PopupWindowClass extends Astal.Window {
	_revealer?: Gtk.Revealer

	override vfunc_show() {
		super.vfunc_show()
		this._revealer?.set_reveal_child(true)
	}

	override vfunc_hide() {
		this._revealer?.set_reveal_child(false)
	}

	performHide() {
		super.vfunc_hide()
		this.notify("visible")
	}
}

const PopupWindowImpl = GObject.registerClass(PopupWindowClass)

export function PopupWindow({
	name = 'popup',
	class: className,
	layout = 'center',
	transitionType,
	decorated = false,
	visible = false,
	keymode = Astal.Keymode.ON_DEMAND,
	anchor = TOP | BOTTOM | LEFT | RIGHT,
	exclusivity = Astal.Exclusivity.IGNORE,
	layer = Astal.Layer.TOP,
	handleClosing = true,
	onKey,
	onClick,
	children,
	$,
	...props
}: Props<PopupWindowClass, PopupWindowProps> & {
	onKey?: (
		ctrl: Gtk.EventControllerKey,
		keyval: number,
		code: number,
		mod: number,
		w: Gtk.Window
	) => void
	onClick?: (
		ctrl: Gtk.GestureClick,
		n: number,
		x: number,
		y: number,
		w: Gtk.Window,
		content: Gtk.Widget
	) => void
	handleClosing?: boolean
}) {
	let content: Gtk.Revealer
	let win: PopupWindowClass

	const alignment = typeof layout === 'function'
		? layout.as(getPosConfig)
		: getPosConfig(layout)

	const isAccessor = typeof alignment === 'function'

	return (
		<PopupWindowImpl
			$={w => {
				win = w
				$ && $(w)
			}}
			name={name}
			class={`${name} popup-window ${className}`}
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

			<revealer
				transitionDuration={options.transition.duration}
				transitionType={transitionType ?? (isAccessor ? alignment.as(v => v.transitionType) : alignment.transitionType)}
				halign={isAccessor ? alignment.as(v => v.halign) : alignment.halign}
				valign={isAccessor ? alignment.as(v => v.valign) : alignment.valign}
				onNotifyChildRevealed={(self) => {
					if (!self.get_child_revealed()) {
						win.performHide()
					}
				}}
				$={c => {
					content = c
					onMount(() => {
						win._revealer = c
					})
				}}
			>
				{children}
			</revealer>
		</PopupWindowImpl >
	)
}
