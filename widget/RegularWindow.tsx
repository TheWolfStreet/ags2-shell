import { GObject } from "astal"
import { App, Gtk, astalify, type ConstructProps } from "astal/gtk3"

export class RegularWindow extends astalify(Gtk.Window) {
	static {
		GObject.registerClass(this)
	}

	constructor(props: ConstructProps<
		RegularWindow,
		Gtk.Window.ConstructorProps
	> = {}) {
		props.application = props.application || App
		super(props as any)
	}
}
