// Renders theme names and icon file paths within a fixed square allocation.

import { createComputed, With } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import { createSquareTextureAccessor } from "$lib/textures"
import { type MaybeAccessor, readValue } from "$lib/ui"

function renderIcon(icon: string, size: number) {
	if (icon.includes("/")) {
		const texture = createSquareTextureAccessor(icon, size)
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
		icon: readValue(icon),
		size: readValue(size),
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
				{value => renderIcon(value.icon, value.size)}
			</With>
		</box>
	)
}
