import { Accessor, CCProps } from "ags"
import { Gtk } from "ags/gtk4"

export type Props<T extends Gtk.Widget, Props> = CCProps<T, Partial<Props>>

export function toggle_class(widget: Gtk.Widget, name: string, enable?: boolean) {
	if (enable === undefined)
		enable = !widget.has_css_class(name)

	if (enable)
		widget.add_css_class(name)
	else
		widget.remove_css_class(name)
}

export function is_dialog_dismissed(error: unknown) {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& error.code === Gtk.DialogError.DISMISSED
}

export type MaybeAccessor<T> = Accessor<T> | T

export function is_accessor<T>(value: unknown): value is Accessor<T> {
	return typeof value === "function" && "peek" in value
}

export function read_value<T>(value: MaybeAccessor<T>): T {
	return is_accessor(value) ? value() : value
}
