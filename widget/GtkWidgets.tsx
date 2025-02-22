import { GObject } from "astal"
import { Gtk, astalify, type ConstructProps } from "astal/gtk3"

export class Spinner extends astalify(Gtk.Spinner) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		Spinner,
		Gtk.Spinner.ConstructorProps
	>) {
		super(props as any)
	}
}

export class Separator extends astalify(Gtk.Separator) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		Separator,
		Gtk.Separator.ConstructorProps
	>) {
		super(props as any)
	}
}

export class FileChooserButton extends astalify(Gtk.FileChooserButton) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		FileChooserButton,
		Gtk.FileChooserButton.ConstructorProps
	>) {
		super(props as any)
	}
}

export class FontButton extends astalify(Gtk.FontButton) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		FontButton,
		Gtk.FontButton.ConstructorProps
	>) {
		super(props as any)
	}
}

export class ColorButton extends astalify(Gtk.ColorButton) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		ColorButton,
		Gtk.ColorButton.ConstructorProps
	>) {
		super(props as any)
	}
}

export class Calendar extends astalify(Gtk.Calendar) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		Calendar,
		Gtk.Calendar.ConstructorProps
	>) {
		super(props as any)
	}
}

export class SpinButton extends astalify(Gtk.SpinButton) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		SpinButton,
		Gtk.SpinButton.ConstructorProps
	>) {
		super(props as any)
	}
}

export class Fixed extends astalify(Gtk.Fixed) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		Fixed,
		Gtk.Fixed.ConstructorProps
	>) {
		super(props as any)
	}
}

export class ProgressBar extends astalify(Gtk.ProgressBar) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		ProgressBar,
		Gtk.ProgressBar.ConstructorProps
	>) {
		super(props as any)
	}
}


export class AspectFrame extends astalify(Gtk.AspectFrame) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		AspectFrame,
		Gtk.AspectFrame.ConstructorProps
	>) {
		super(props as any)
	}
}
export class Menu extends astalify(Gtk.Menu) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		Menu,
		Gtk.Menu.ConstructorProps
	>) {
		super(props as any)
	}
}

export class MenuItem extends astalify(Gtk.MenuItem) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		MenuItem,
		Gtk.MenuItem.ConstructorProps
	>) {
		super(props as any)
	}
}

export class ScrolledWindow extends astalify(Gtk.ScrolledWindow) {
	static { GObject.registerClass(this) }

	constructor(props: ConstructProps<
		ScrolledWindow,
		Gtk.ScrolledWindow.ConstructorProps
	>) {
		super(props as any)
	}
}
