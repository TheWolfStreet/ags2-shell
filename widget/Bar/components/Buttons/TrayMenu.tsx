import { Gtk } from "ags/gtk4"
import { onCleanup } from "ags"
import { idle, type Timer } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import AstalTray from "gi://AstalTray"

import { create_animated_popover } from "widget/shared/AnimatedPopover"

const { VERTICAL, HORIZONTAL } = Gtk.Orientation
const { BOTTOM, RIGHT } = Gtk.PositionType
const { START, CENTER } = Gtk.Align

const string_variant = GLib.VariantType.new("s")

function attribute_string(
	model: Gio.MenuModel,
	index: number,
	attribute: string,
) {
	const value = model.get_item_attribute_value(index, attribute, string_variant)
	return value ? value.get_string()[0] : ""
}

function action_name(full_action: string) {
	const dot = full_action.indexOf(".")
	return dot >= 0 ? full_action.slice(dot + 1) : full_action
}

function is_checked(
	action_group: Gio.ActionGroup,
	name: string,
	target: GLib.Variant | null,
) {
	const state = action_group.get_action_state(name)
	if (!state) return false

	if (state.get_type_string() === "b") return target ? state.equal(target) : state.get_boolean()

	return target ? state.equal(target) : false
}

function build_item_button(
	model: Gio.MenuModel,
	index: number,
	label: string,
	action_group: Gio.ActionGroup | null,
	close_root: () => void,
) {
	const full_action = attribute_string(model, index, "action")
	const target = model.get_item_attribute_value(index, "target", null)
	const name = action_name(full_action)
	const known = !!action_group && !!name && action_group.has_action(name)

	const button = new Gtk.Button()
	button.add_css_class("model-item")
	button.set_sensitive(known && action_group!.get_action_enabled(name))

	const content = new Gtk.Box({ orientation: HORIZONTAL })
	if (known && is_checked(action_group!, name, target)) {
		const check = new Gtk.Image({
			iconName: "object-select-symbolic",
			valign: CENTER,
		})
		check.add_css_class("check")
		content.append(check)
	}
	content.append(
		new Gtk.Label({
			label,
			useUnderline: true,
			xalign: 0,
			halign: START,
			hexpand: true,
		}),
	)
	button.set_child(content)

	button.connect("clicked", () => {
		if (known) action_group!.activate_action(name, target)
		close_root()
	})

	return button
}

function build_submenu_button(
	label: string,
	submodel: Gio.MenuModel,
	action_group: Gio.ActionGroup | null,
	close_root: () => void,
	register: (fn: () => void) => void,
	budget: { remaining: number },
	ancestors: Set<Gio.MenuModel>,
	depth: number,
) {
	const button = new Gtk.Button()
	button.add_css_class("model-item")
	button.add_css_class("submenu")

	const content = new Gtk.Box({ orientation: HORIZONTAL })
	content.append(
		new Gtk.Label({
			label,
			useUnderline: true,
			xalign: 0,
			halign: START,
			hexpand: true,
		}),
	)
	content.append(
		new Gtk.Image({ iconName: "go-next-symbolic", valign: CENTER }),
	)
	button.set_child(content)

	const { popover, revealer, dispose } = create_animated_popover(RIGHT)
	popover.set_parent(button)
	revealer.set_child(
		build_menu_box(
			submodel,
			action_group,
			() => {
				popover.popdown()
				close_root()
			},
			register,
			budget,
			ancestors,
			depth + 1,
		),
	)

	button.connect("clicked", () => popover.popup())
	register(() => { dispose(); popover.unparent() })

	return button
}

function append_model(
	box: Gtk.Box,
	model: Gio.MenuModel,
	action_group: Gio.ActionGroup | null,
	close_root: () => void,
	register: (fn: () => void) => void,
	budget: { remaining: number },
	ancestors: Set<Gio.MenuModel>,
	depth: number,
) {
	if (depth > 16 || ancestors.has(model)) return
	ancestors.add(model)
	const count = model.get_n_items()
	for (let i = 0; i < count && budget.remaining > 0; i++) {
		budget.remaining--
		const section = model.get_item_link(i, "section")
		if (section) {
			if (box.get_last_child()) box.append(new Gtk.Separator())
			append_model(box, section, action_group, close_root, register, budget, ancestors, depth + 1)
			continue
		}

		const label = attribute_string(model, i, "label")
		const submenu = model.get_item_link(i, "submenu")
		if (submenu) {
			box.append(
				build_submenu_button(label, submenu, action_group, close_root, register, budget, ancestors, depth),
			)
			continue
		}

		box.append(build_item_button(model, i, label, action_group, close_root))
	}
	ancestors.delete(model)
}

function build_menu_box(
	model: Gio.MenuModel,
	action_group: Gio.ActionGroup | null,
	close_root: () => void,
	register: (fn: () => void) => void,
	budget = { remaining: 200 },
	ancestors = new Set<Gio.MenuModel>(),
	depth = 0,
) {
	const box = new Gtk.Box({ orientation: VERTICAL })
	box.add_css_class("tray-menu")
	append_model(box, model, action_group, close_root, register, budget, ancestors, depth)
	return box
}

export function create_tray_menu_popover(item: AstalTray.TrayItem) {
	const { popover, revealer, dispose } = create_animated_popover(BOTTOM)

	let cleanups: Array<() => void> = []
	const register = (fn: () => void) => cleanups.push(fn)
	const run_cleanups = () => {
		cleanups.forEach((fn) => fn())
		cleanups = []
	}

	let dirty = true
	let rebuild_timer: Timer | null = null
	const mark_dirty = () => {
		dirty = true
		if (popover.get_mapped() && !rebuild_timer)
			rebuild_timer = idle(() => {
				rebuild_timer = null
				if (popover.get_mapped()) ensure_built()
			})
	}

	const rebuild = () => {
		run_cleanups()
		const model = item.menuModel
		if (!model) {
			revealer.set_child(new Gtk.Box({ orientation: VERTICAL }))
		} else {
			revealer.set_child(
				build_menu_box(
					model,
					item.actionGroup,
					() => popover.popdown(),
					register,
				),
			)
		}
		dirty = false
	}

	const ensure_built = () => {
		if (dirty) {
			rebuild()
			connect_model()
		}
	}

	let model_cleanups: Array<() => void> = []
	let action_cleanups: Array<() => void> = []
	const connect_model = () => {
		model_cleanups.forEach((cleanup) => cleanup())
		model_cleanups = []
		const seen = new Set<Gio.MenuModel>()
		let remaining = 200
		const watch = (model: Gio.MenuModel, depth: number) => {
			if (depth > 16 || seen.has(model) || remaining <= 0) return
			seen.add(model)
			const id = model.connect("items-changed", mark_dirty)
			model_cleanups.push(() => model.disconnect(id))
			for (let index = 0; index < model.get_n_items() && remaining > 0; index++) {
				remaining--
				for (const link of ["section", "submenu"]) {
					const child = model.get_item_link(index, link)
					if (child) watch(child, depth + 1)
				}
			}
		}
		const model = item.menuModel
		if (model) watch(model, 0)
	}

	const connect_action_group = () => {
		action_cleanups.forEach((cleanup) => cleanup())
		action_cleanups = []
		const group = item.actionGroup
		if (!group) return
		for (const signal of ["action-added", "action-removed", "action-enabled-changed", "action-state-changed"] as const) {
			const id = group.connect(signal, mark_dirty)
			action_cleanups.push(() => group.disconnect(id))
		}
	}

	connect_model()
	connect_action_group()

	const item_connections = [
		item.connect("notify::menu-model", () => { connect_model(); mark_dirty() }),
		item.connect("notify::action-group", () => { connect_action_group(); mark_dirty() }),
	]

	onCleanup(() => {
		item_connections.forEach((id) => item.disconnect(id))
		rebuild_timer?.cancel()
		model_cleanups.forEach((cleanup) => cleanup())
		action_cleanups.forEach((cleanup) => cleanup())
		run_cleanups()
		dispose()
		popover.unparent()
	})

	return { popover, ensure_built }
}
