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
		if (
			revealer &&
			(revealer.get_reveal_child() || revealer.get_child_revealed())
		) {
			revealer.set_reveal_child(false)
			return
		}
		super.vfunc_hide()
	}

	perform_hide() {
		super.vfunc_hide()
	}
}

const AnimatedPopover = GObject.registerClass(AnimatedPopoverImpl)

export function create_animated_popover(
	position: Gtk.PositionType,
	add_menu_class = true,
): { popover: Gtk.Popover; revealer: Gtk.Revealer; dispose: () => void } {
	const popover = new AnimatedPopover() as AnimatedPopoverImpl
	popover.set_has_arrow(false)
	popover.set_position(position)
	if (add_menu_class) popover.add_css_class("menu")

	const revealer = new Gtk.Revealer({
		transitionType: Gtk.RevealerTransitionType.SLIDE_DOWN,
		transitionDuration: options.transition.duration.peek(),
	})
	const handler = revealer.connect("notify::child-revealed", (self) => {
		if (!self.get_child_revealed() && !self.get_reveal_child())
			popover.perform_hide()
	})

	const unsubscribe_duration = options.transition.duration.subscribe(() =>
		revealer.set_transition_duration(options.transition.duration.peek()),
	)

	popover.revealer = revealer
	popover.set_child(revealer)
	return {
		popover,
		revealer,
		dispose: () => {
			unsubscribe_duration()
			revealer.disconnect(handler)
		},
	}
}

function bar_popover_position() {
	if (options.bar.position.peek() === "top-center")
		return Gtk.PositionType.BOTTOM
	return Gtk.PositionType.TOP
}

export function follow_bar_position(popover: Gtk.Popover): () => void {
	const update = () => popover.set_position(bar_popover_position())
	update()
	return options.bar.position.subscribe(update)
}
