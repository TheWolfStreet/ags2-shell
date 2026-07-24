// Calculates dock size and icon scale for the selected monitor edge.

import { Accessor, createComputed } from "ags"
import { Gdk } from "ags/gtk4"

import { DockItem, isLeftPosition, isOnLeft } from "widget/Dock/components/items"

import options from "options"

export function dockSizing(dockItems: Accessor<DockItem[]>, geometry: Accessor<Gdk.Rectangle>) {
	const { mode, position, scale } = options.dock
	const globalScale = options.scale

	const dockScale = createComputed(() => {
		const g = globalScale() / 100
		const userScale = scale() / 100
		const count = dockItems().length
		if (count === 0) return userScale
		const geom = geometry()
		const screenLen = isOnLeft() ? geom.height : geom.width
		const maxScale = (screenLen * 0.88 - 2 - count * 11 * g) / (count * 64 * g)
		return Math.max(0.3, Math.min(userScale, maxScale))
	})

	const pixelScale = createComputed(() => dockScale() * (globalScale() / 100))

	return {
		hotzoneThickness: createComputed(() => Math.max(16, Math.round(22 * pixelScale()))),
		windowThickness: createComputed(() => Math.max(48, Math.round(94 * pixelScale()))),
		edgeMargin: createComputed(() => Math.round(16 * pixelScale())),
		iconSize: createComputed(() => Math.max(16, Math.round(64 * pixelScale()))),
		dockScale,
		dockClassName: createComputed(() =>
			`dock-container ${isLeftPosition(position()) ? "dock-vertical" : "dock-horizontal"} ${position()} dock-${mode()}`),
	}
}
