// Tracks desktop selection, copied files, redraw requests, and renaming across monitors.

import { createComputed, createState } from "ags"
import { Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import { desktop } from "$service/Desktop"
import { getDesktopIconMetrics } from "$service/Desktop/geometry"

import options from "options"

const [selected, setSelected] = createState<string[]>([])
const [pressed, setPressed] = createState<string | null>(null)
const [renamePath, setRenamePath] = createState<string | null>(null)
const [renameValue, setRenameValue] = createState("")
const roots = new Set<Gtk.Widget>()

export const session = {
	enabled: options.desktop.enabled,
	iconMetrics: createComputed(() => getDesktopIconMetrics(options.desktop.iconSize())),
	clipboard: desktop.clipboard,
	selected,
	pressed,
	select: setSelected,
	press: setPressed,
	redraw() {
		idle(() => roots.forEach(root => root.queue_draw()))
	},
	roots: {
		add(root: Gtk.Widget) {
			roots.add(root)
		},
		delete(root: Gtk.Widget) {
			roots.delete(root)
		},
	},
	rename: {
		path: renamePath,
		value: renameValue,
		setValue: setRenameValue,
		begin(path: string) {
			const name = path.split("/").pop() || ""
			if (renamePath.peek() === path) {
				setRenamePath(null)
				idle(() => {
					setRenameValue(name)
					setRenamePath(path)
				})
			} else {
				setRenameValue(name)
				setRenamePath(path)
			}
			setSelected([path])
		},
		commit() {
			const target = renamePath.peek()
			const name = renameValue.peek().trim()
			if (!target || !name || (target.split("/").pop() || "") === name) {
				setRenamePath(null)
				return
			}

			const path = desktop.rename(target, name)
			if (path)
				setSelected([path])
			setRenamePath(null)
		},
		cancel() {
			setRenamePath(null)
		},
	},
}
