// Shows an animated popup in the right place and closes it after an outside click.

import { createComputed, onCleanup, onMount, type Accessor } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import Graphene from "gi://Graphene"

import { isAccessor, type Props } from "$lib/ui"

import options from "$shell/options"

type VerticalPosition = "top" | "center" | "bottom"
type HorizontalPosition = "left" | "center" | "right"
export type Position = `${VerticalPosition}-${HorizontalPosition}` | "center"

export function createPopupPosition(bar: Accessor<string>, popup: Accessor<string>): Accessor<Position> {
	return createComputed(() => {
		const vertical = bar().split("-")[0]
		const horizontal = popup().split("-").pop() ?? "center"
		return `${vertical}-${horizontal}` as Position
	})
}

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
}: Props<PopupWindowImpl, PopupProps> & {
	handleClosing?: boolean
	onKey?: (controller: Gtk.EventControllerKey, keyval: number, keycode: number, modifiers: number, window: Gtk.Window) => void
	onClick?: (controller: Gtk.GestureClick, pressCount: number, x: number, y: number, window: Gtk.Window, content: Gtk.Widget) => void
}) {
	let content: Gtk.Revealer
	let window: PopupWindowImpl
	let visibilityUnsubscribe: (() => void) | undefined

	const alignment = createComputed(() => getPositionConfig(layout))
	const initialVisible = isAccessor<boolean>(visible) ? visible.peek() : visible

	const pickAlignment = <K extends keyof AlignConfig>(key: K) => {
		return alignment.as(config => config[key])
	}

	onCleanup(() => visibilityUnsubscribe?.())

	return (
		<RegisteredPopupWindow
			$={popupWindow => {
				window = popupWindow
				$?.(popupWindow)
				if (isAccessor<boolean>(visible))
					visibilityUnsubscribe = visible.subscribe(() => popupWindow.setRequestedVisible(visible.peek()))
			}}
			name={name}
			class={`popup-window${name ? ` ${name}` : ""}${className ? ` ${className}` : ""}`}
			decorated={decorated}
			visible={initialVisible}
			keymode={keymode}
			anchor={anchor}
			exclusivity={exclusivity}
			layer={layer}
			{...props}
		>
			<Gtk.EventControllerKey onKeyPressed={(controller, keyval, keycode, modifiers) => handleClosing && onKeyHandler(controller, keyval, keycode, modifiers, window, onKey)} />
			<Gtk.GestureClick onPressed={(controller, pressCount, x, y) => handleClosing && onClickHandler(controller, pressCount, x, y, window, content, onClick)} />

			<Gtk.Revealer
				transitionDuration={options.transition.duration}
				transitionType={transitionType ?? pickAlignment("transitionType")}
				halign={pickAlignment("halign")}
				valign={pickAlignment("valign")}
				onNotifyChildRevealed={(self) => {
					if (!self.get_child_revealed() && !self.get_reveal_child()) {
						// The real window stays visible until the revealer finishes so the closing transition can render.
						window.performHide()
					}
				}}
				$={self => {
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

function onKeyHandler(
	controller: Gtk.EventControllerKey,
	keyval: number,
	keycode: number,
	modifiers: number,
	window: Gtk.Window,
	onKey?: (controller: Gtk.EventControllerKey, keyval: number, keycode: number, modifiers: number, window: Gtk.Window) => void
) {
	if (keyval === KEY_Escape) window.hide()
	onKey?.(controller, keyval, keycode, modifiers, window)
}

function onClickHandler(
	controller: Gtk.GestureClick,
	pressCount: number,
	x: number,
	y: number,
	window: Gtk.Window,
	content: Gtk.Widget,
	onClick?: (controller: Gtk.GestureClick, pressCount: number, x: number, y: number, window: Gtk.Window, content: Gtk.Widget) => void
) {
	const [, rect] = content.compute_bounds(window)
	const point = new Graphene.Point({ x, y })
	if (!rect.contains_point(point)) window.hide()
	onClick?.(controller, pressCount, x, y, window, content)
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

function isPosition(value: unknown): value is Position {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(POSITION_CONFIG, value)
}

function getPositionConfig(value: unknown): AlignConfig {
	if (isAccessor<unknown>(value))
		return getPositionConfig(value())
	return isPosition(value) ? POSITION_CONFIG[value] : POSITION_CONFIG.center
}

interface PopupProps extends Astal.Window.ConstructorProps {
	children: JSX.Element | Array<JSX.Element>
	layout?: Position | Accessor<Position>
	transitionType?: Gtk.RevealerTransitionType
}

class PopupWindowImpl extends Astal.Window {
	revealer?: Gtk.Revealer

	setRequestedVisible(visible: boolean) {
		if (visible) {
			this.show()
			this.resetRevealerOpacity()
			this.revealer?.set_reveal_child(true)
		} else {
			this.hide()
		}
	}

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

const RegisteredPopupWindow = GObject.registerClass(PopupWindowImpl)
