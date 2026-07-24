// Updates widget classes, adds label tooltips, reads values, and creates number ranges.

import { Accessor, CCProps } from "ags"
import { idle } from "ags/time"
import { Gtk } from "ags/gtk4"

import Pango from "gi://Pango"

export type Props<T extends Gtk.Widget, Props> = CCProps<T, Partial<Props>>

export function toggleClass(widget: Gtk.Widget, name: string, enable?: boolean) {
	if (enable === undefined)
		enable = !widget.has_css_class(name)

	if (enable)
		widget.add_css_class(name)
	else
		widget.remove_css_class(name)
}

export function isInsideEntry(widget: Gtk.Widget | null) {
	let current: Gtk.Widget | null = widget

	while (current) {
		if (current instanceof Gtk.Entry)
			return true

		current = current.get_parent()
	}

	return false
}

export function updateLabelTooltip(label: Gtk.Label) {
	idle(() => {
		if (!label.get_visible?.())
			return

		const layout = label.get_layout?.()
		const isEllipsized = layout?.is_ellipsized?.()
			?? (layout?.get_ellipsize?.() ?? Pango.EllipsizeMode.NONE) !== Pango.EllipsizeMode.NONE
		const text = label.get_text?.() ?? ""
		label.set_tooltip_text(isEllipsized ? text : null)
	})
}

export type MaybeAccessor<T> = Accessor<T> | T

export function isAccessor<T>(value: unknown): value is Accessor<T> {
	return typeof value === "function" && "peek" in value
}

export function readValue<T>(value: MaybeAccessor<T>): T {
	return isAccessor(value) ? value.peek() : value
}

export function range(length: number, start = 1) {
	return Array.from({ length }, (_, i) => i + start)
}
