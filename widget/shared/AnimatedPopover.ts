// Creates popovers that finish hiding after their content transition settles.

import { Gtk } from "ags/gtk4"
import GObject from "ags/gobject"

import options from "$shell/options"

class AnimatedPopoverImpl extends Gtk.Popover {
	revealer?: Gtk.Revealer

	override vfunc_show() {
		super.vfunc_show()
		this.revealer?.set_reveal_child(true)
	}

	override vfunc_hide() {
		const revealer = this.revealer
		if (revealer && (revealer.get_reveal_child() || revealer.get_child_revealed())) {
			revealer.set_reveal_child(false)
			return
		}
		super.vfunc_hide()
	}

	performHide() {
		super.vfunc_hide()
	}
}

const AnimatedPopover = GObject.registerClass(AnimatedPopoverImpl)

export function createAnimatedPopover(
	position: Gtk.PositionType,
	addMenuClass = true,
): { popover: Gtk.Popover; revealer: Gtk.Revealer } {
	const popover = new AnimatedPopover() as AnimatedPopoverImpl
	popover.set_has_arrow(false)
	popover.set_position(position)
	if (addMenuClass)
		popover.add_css_class("menu")

	const revealer = new Gtk.Revealer({
		transitionType: Gtk.RevealerTransitionType.SLIDE_DOWN,
		transitionDuration: options.transition.duration.peek(),
	})
	revealer.connect("notify::child-revealed", self => {
		if (!self.get_child_revealed() && !self.get_reveal_child())
			popover.performHide()
	})

	popover.revealer = revealer
	popover.set_child(revealer)
	return { popover, revealer }
}
