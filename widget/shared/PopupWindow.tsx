import { Accessor, createState, Node } from "ags"
import app from "ags/gtk4/app"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import Graphene from "gi://Graphene"

import { Props } from "$lib/utils"

import options from "options"
import GLib from "gi://GLib?version=2.0"

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

// TODO: This entire ordeal is a mess, subclass, then spawn, then assign revealer state outside in some function that creates it. Need to find a more elegant solution
// declare the class itself

interface PopupWindowProps extends Astal.Window.ConstructorProps {
	children?: Node | Node[]
	layout?: Position
	transitionType?: Gtk.RevealerTransitionType
}

class PopupWindowClass extends Astal.Window {
	_set_reveal: (v: boolean) => void = () => { }
	_hide_timeout: GLib.Source | undefined

	override vfunc_show() {
		if (this._hide_timeout) {
			clearTimeout(this._hide_timeout)
			this._hide_timeout = undefined
		}
		super.vfunc_show()
		this._set_reveal(true)
	}

	override vfunc_hide() {
		this._set_reveal(false)
		this._hide_timeout = setTimeout(() => {
			super.vfunc_hide()
			this._hide_timeout = undefined
		}, options.transition.get())
	}

	override vfunc_close_request() {
		this._set_reveal(false)
		this._hide_timeout = setTimeout(() => {
			super.vfunc_close_request()
			this._hide_timeout = undefined
		}, options.transition.get())
		return true
	}
}

export const PopupWindowImpl = GObject.registerClass(PopupWindowClass)

export default function PopupWindow({
	name = 'popup',
	children,
	layout = 'center',
	onKey,
	onClick,
	transitionType,
	exclusivity = Astal.Exclusivity.IGNORE,
	layer = Astal.Layer.OVERLAY,
	keymode = Astal.Keymode.ON_DEMAND,
	resizable = false,
	visible = false,
	anchor = Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM | Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT,
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
}) {
	let content: Gtk.Widget
	let win: PopupWindowClass

	const alignment = typeof layout === 'function'
		? layout.as(getPosConfig)
		: getPosConfig(layout)

	const isAccessor = typeof alignment === 'function'
	const mon = app.get_monitors()[0].geometry
	const [reveal, set_reveal] = createState(false)

	return (
		<PopupWindowImpl
			{...props}
			$={w => {
				w._set_reveal = set_reveal
				win = w
			}}
			defaultHeight={mon.height}
			defaultWidth={mon.width}
			exclusivity={exclusivity}
			layer={layer}
			class={`${name} popup-window`}
			name={name}
			resizable={resizable}
			visible={visible}
			keymode={keymode}
			anchor={anchor}
		>
			<Gtk.EventControllerKey onKeyPressed={(ctrl, keyval, code, mod) => onKeyHandler(ctrl, keyval, code, mod, win, onKey)} />
			<Gtk.GestureClick onPressed={(ctrl, n, x, y) => onClickHandler(ctrl, n, x, y, win, content, onClick)} />

			<overlay>
				<revealer
					revealChild={reveal}
					transitionDuration={options.transition}
					transitionType={transitionType ?? (isAccessor ? alignment.as(v => v.transitionType) : alignment.transitionType)}
					halign={isAccessor ? alignment.as(v => v.halign) : alignment.halign}
					valign={isAccessor ? alignment.as(v => v.valign) : alignment.valign}
					$={c => content = c}
				>
					{children}
				</revealer>
			</overlay>
		</PopupWindowImpl>
	)
}
