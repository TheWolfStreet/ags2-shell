import { createBinding, createComputed, With } from "ags"
import { Gdk, Gtk } from "ags/gtk4"

import type AstalHyprland from "gi://AstalHyprland"

import { create_texture_accessor } from "$lib/textures"
import { type maybe_accessor, read_value } from "$lib/ui"

export function client_identity(client: AstalHyprland.Client) {
	return {
		class: createBinding(client, "class")(),
		initialClass: createBinding(client, "initialClass")(),
		title: createBinding(client, "title")(),
		initialTitle: createBinding(client, "initialTitle")(),
	}
}

function render_icon(icon: string, size: number) {
	if (icon.includes("/")) {
		const texture = create_texture_accessor(icon, size)
		return (
			<Gtk.Picture
				paintable={texture.as((value) => value as Gdk.Paintable)}
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
	icon: maybe_accessor<string>
	size: maybe_accessor<number>
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
			widthRequest={values.as((value) => value.size)}
			heightRequest={values.as((value) => value.size)}
			halign={halign}
			valign={valign}
		>
			<With value={values}>
				{(value) => render_icon(value.icon, value.size)}
			</With>
		</box>
	)
}
