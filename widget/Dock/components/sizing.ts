import { Accessor, createComputed } from "ags"
import { Gdk } from "ags/gtk4"

import { DockItem, isLeftPosition, isOnLeft } from "widget/Dock/components/items"

import options from "options"

export function dockSizing(dockItems: Accessor<DockItem[]>, geometry: Accessor<Gdk.Rectangle>) {
	const { mode, position, scale } = options.dock
	const autoScale = createComputed(() => {
		const userScale = scale() / 100
		const count = dockItems().length
		if (count === 0) return userScale
		const geom = geometry()
		const screenLen = isOnLeft() ? geom.height : geom.width
		const maxScale = (screenLen * 0.88 - 2 - count * 11) / (count * 64)
		return Math.max(0.3, Math.min(userScale, maxScale))
	})

	return {
		hotzoneThickness: createComputed(() => Math.max(16, Math.round(22 * autoScale()))),
		windowThickness: createComputed(() => Math.max(48, Math.round(94 * autoScale()))),
		edgeMargin: createComputed(() => Math.round(16 * autoScale())),
		iconSize: createComputed(() => Math.max(16, Math.round(64 * autoScale()))),
		dockClassName: createComputed(() =>
			`dock-container ${isLeftPosition(position()) ? "dock-vertical" : "dock-horizontal"} ${position()} dock-${mode()}`),
	}
}
