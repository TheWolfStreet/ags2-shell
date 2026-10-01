import { createComputed, With } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import { create_square_texture_accessor } from "$lib/textures"
import { type MaybeAccessor, read_value } from "$lib/ui"

function render_icon(icon: string, size: number) {
	if (icon.includes("/")) {
		const texture = create_square_texture_accessor(icon, size)
		return (
			<Gtk.Picture
				paintable={texture.as(value => value as Gdk.Paintable)}
				widthRequest={size}
				heightRequest={size}
				halign={Gtk.Align.CENTER}
				valign={Gtk.Align.CENTER}
				contentFit={Gtk.ContentFit.CONTAIN}
				canShrink
			/>
		)
	}

	return (
		<image
			visible={Boolean(icon)}
			iconName={icon}
			pixelSize={size}
			widthRequest={size}
			heightRequest={size}
			halign={Gtk.Align.CENTER}
			valign={Gtk.Align.CENTER}
			useFallback
		/>
	)
}

export function ApplicationIcon({
	icon,
	size,
	halign = Gtk.Align.CENTER,
	valign = Gtk.Align.CENTER,
}: {
	icon: MaybeAccessor<string>
	size: MaybeAccessor<number>
	halign?: Gtk.Align
	valign?: Gtk.Align
}) {
	const values = createComputed(() => ({
		icon: read_value(icon),
		size: read_value(size),
	}))
	return (
		<box
			class="application-icon"
			widthRequest={values.as(value => value.size)}
			heightRequest={values.as(value => value.size)}
			halign={halign}
			valign={valign}
		>
			<With value={values}>
				{value => render_icon(value.icon, value.size)}
			</With>
		</box>
	)
}
