import { Gtk } from "ags/gtk4"
import { onCleanup } from "ags"
import { idle, type timer } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import AstalTray from "gi://AstalTray"

import {
	create_animated_popover,
	follow_bar_position,
} from "widget/shared/animated_popover"
import icons from "$lib/icons"

const { VERTICAL, HORIZONTAL } = Gtk.Orientation
const { BOTTOM, RIGHT } = Gtk.PositionType
const { START, CENTER } = Gtk.Align

const string_variant = GLib.VariantType.new("s")
const max_menu_depth = 16
const max_menu_items = 200
const action_group_signals = [
	"action-added",
	"action-removed",
	"action-enabled-changed",
	"action-state-changed",
] as const

type menu_context = {
	action_group: Gio.ActionGroup | null
	close_root: () => void
	register: (cleanup: () => void) => void
	budget: { remaining: number }
	ancestors: Set<Gio.MenuModel>
}

function create_cleanups() {
	let pending: (() => void)[] = []
	return {
		add(cleanup: () => void) {
			pending.push(cleanup)
		},
		run() {
			for (const cleanup of pending) cleanup()
			pending = []
		},
	}
}

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

function owning_group(group: Gio.ActionGroup | null, name: string) {
	if (!group || !name || !group.has_action(name)) return null
	return group
}

function is_checked(
	group: Gio.ActionGroup,
	name: string,
	target: GLib.Variant | null,
) {
	const state = group.get_action_state(name)
	if (!state) return false
	if (target) return state.equal(target)
	return state.get_type_string() === "b" && state.get_boolean()
}

function menu_button() {
	const button = new Gtk.Button()
	button.add_css_class("model-item")
	return button
}

function menu_label(label: string) {
	return new Gtk.Label({
		label,
		useUnderline: true,
		xalign: 0,
		halign: START,
		hexpand: true,
	})
}

function check_icon() {
	const check = new Gtk.Image({ iconName: icons.ui.tick, valign: CENTER })
	check.add_css_class("check")
	return check
}

function build_item_button(
	model: Gio.MenuModel,
	index: number,
	label: string,
	context: menu_context,
) {
	const name = action_name(attribute_string(model, index, "action"))
	const target = model.get_item_attribute_value(index, "target", null)
	const group = owning_group(context.action_group, name)

	const button = menu_button()
	button.set_sensitive(!!group && group.get_action_enabled(name))

	const content = new Gtk.Box({ orientation: HORIZONTAL })
	if (group && is_checked(group, name, target)) content.append(check_icon())
	content.append(menu_label(label))
	button.set_child(content)

	button.connect("clicked", () => {
		group?.activate_action(name, target)
		context.close_root()
	})
	return button
}

function build_submenu_button(
	label: string,
	submodel: Gio.MenuModel,
	context: menu_context,
	depth: number,
) {
	const button = menu_button()
	button.add_css_class("submenu")

	const content = new Gtk.Box({ orientation: HORIZONTAL })
	content.append(menu_label(label))
	content.append(new Gtk.Image({ iconName: icons.ui.next, valign: CENTER }))
	button.set_child(content)

	const { popover, revealer, dispose } = create_animated_popover(RIGHT)
	popover.set_parent(button)
	const close_root = () => {
		popover.popdown()
		context.close_root()
	}
	revealer.set_child(
		build_menu_box(submodel, { ...context, close_root }, depth + 1),
	)

	button.connect("clicked", () => popover.popup())
	context.register(() => {
		dispose()
		popover.unparent()
	})
	return button
}

function append_entry(
	box: Gtk.Box,
	model: Gio.MenuModel,
	index: number,
	context: menu_context,
	depth: number,
) {
	const section = model.get_item_link(index, "section")
	if (section) {
		if (box.get_last_child()) box.append(new Gtk.Separator())
		append_model(box, section, context, depth + 1)
		return
	}

	const label = attribute_string(model, index, "label")
	const submenu = model.get_item_link(index, "submenu")
	if (submenu) {
		box.append(build_submenu_button(label, submenu, context, depth))
		return
	}

	box.append(build_item_button(model, index, label, context))
}

function append_model(
	box: Gtk.Box,
	model: Gio.MenuModel,
	context: menu_context,
	depth: number,
) {
	if (depth > max_menu_depth || context.ancestors.has(model)) return
	context.ancestors.add(model)
	const count = model.get_n_items()
	for (let index = 0; index < count && context.budget.remaining > 0; index++) {
		context.budget.remaining--
		append_entry(box, model, index, context, depth)
	}
	context.ancestors.delete(model)
}

function build_menu_box(
	model: Gio.MenuModel,
	context: menu_context,
	depth: number,
) {
	const box = new Gtk.Box({ orientation: VERTICAL })
	box.add_css_class("tray-menu")
	append_model(box, model, context, depth)
	return box
}

export function create_tray_menu_popover(item: AstalTray.TrayItem) {
	const { popover, revealer, dispose } = create_animated_popover(BOTTOM)
	const stop_following = follow_bar_position(popover)
	const menu_cleanups = create_cleanups()
	const model_cleanups = create_cleanups()
	const action_cleanups = create_cleanups()

	let dirty = true
	let rebuild_timer: timer | null = null
	const mark_dirty = () => {
		dirty = true
		if (!popover.get_mapped() || rebuild_timer) return
		rebuild_timer = idle(() => {
			rebuild_timer = null
			if (popover.get_mapped()) ensure_built()
		})
	}

	const rebuild = () => {
		menu_cleanups.run()
		const model = item.menuModel
		if (!model) revealer.set_child(new Gtk.Box({ orientation: VERTICAL }))
		else
			revealer.set_child(
				build_menu_box(
					model,
					{
						action_group: item.actionGroup,
						close_root: () => popover.popdown(),
						register: menu_cleanups.add,
						budget: { remaining: max_menu_items },
						ancestors: new Set(),
					},
					0,
				),
			)
		dirty = false
	}

	const ensure_built = () => {
		if (!dirty) return
		rebuild()
		connect_model()
	}

	const connect_model = () => {
		model_cleanups.run()
		const seen = new Set<Gio.MenuModel>()
		let remaining = max_menu_items
		const watch = (model: Gio.MenuModel, depth: number) => {
			if (depth > max_menu_depth || seen.has(model) || remaining <= 0) return
			seen.add(model)
			const id = model.connect("items-changed", mark_dirty)
			model_cleanups.add(() => model.disconnect(id))
			for (
				let index = 0;
				index < model.get_n_items() && remaining > 0;
				index++
			) {
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
		action_cleanups.run()
		const group = item.actionGroup
		if (!group) return
		for (const signal of action_group_signals) {
			const id = group.connect(signal, mark_dirty)
			action_cleanups.add(() => group.disconnect(id))
		}
	}

	connect_model()
	connect_action_group()

	const item_connections = [
		item.connect("notify::menu-model", () => {
			connect_model()
			mark_dirty()
		}),
		item.connect("notify::action-group", () => {
			connect_action_group()
			mark_dirty()
		}),
	]

	onCleanup(() => {
		for (const id of item_connections) item.disconnect(id)
		rebuild_timer?.cancel()
		model_cleanups.run()
		action_cleanups.run()
		menu_cleanups.run()
		stop_following()
		dispose()
		popover.unparent()
	})

	return { popover, ensure_built }
}
