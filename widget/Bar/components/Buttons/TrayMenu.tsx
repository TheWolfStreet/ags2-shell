import { Gtk } from "ags/gtk4"
import GObject from "ags/gobject"
import { onCleanup } from "ags"

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import AstalTray from "gi://AstalTray"

import options from "options"

const { VERTICAL, HORIZONTAL } = Gtk.Orientation
const { SLIDE_DOWN } = Gtk.RevealerTransitionType
const { BOTTOM, RIGHT } = Gtk.PositionType
const { START, CENTER } = Gtk.Align

export class AnimatedPopoverImpl extends Gtk.Popover {
	revealer?: Gtk.Revealer

	override vfunc_show() {
		super.vfunc_show()
		this.revealer?.set_reveal_child(true)
	}

	override vfunc_hide() {
		const revealer = this.revealer
		if (revealer && (revealer.get_reveal_child() || revealer.get_child_revealed())) {
			revealer.set_reveal_child(false)
			return
		}
		super.vfunc_hide()
	}

	performHide() {
		super.vfunc_hide()
	}
}

export const AnimatedPopover = GObject.registerClass(AnimatedPopoverImpl)

function createAnimatedPopover(position: Gtk.PositionType) {
	const popover = new AnimatedPopover() as AnimatedPopoverImpl
	popover.set_has_arrow(false)
	popover.set_position(position)
	popover.add_css_class("menu")

	const revealer = new Gtk.Revealer({
		transitionType: SLIDE_DOWN,
		transitionDuration: options.transition.duration.peek(),
	})
	revealer.connect("notify::child-revealed", self => {
		if (!self.get_child_revealed() && !self.get_reveal_child())
			popover.performHide()
	})

	popover.revealer = revealer
	popover.set_child(revealer)
	return { popover, revealer }
}

const STRING_VARIANT = GLib.VariantType.new("s")

function attributeString(model: Gio.MenuModel, index: number, attribute: string) {
	const value = model.get_item_attribute_value(index, attribute, STRING_VARIANT)
	return value ? value.get_string()[0] : ""
}

function actionName(fullAction: string) {
	const dot = fullAction.indexOf(".")
	return dot >= 0 ? fullAction.slice(dot + 1) : fullAction
}

function isChecked(actionGroup: Gio.ActionGroup, name: string, target: GLib.Variant | null) {
	const state = actionGroup.get_action_state(name)
	if (!state)
		return false

	if (state.get_type_string() === "b")
		return state.get_boolean()

	return target ? state.equal(target) : false
}

function buildItemButton(
	model: Gio.MenuModel,
	index: number,
	label: string,
	actionGroup: Gio.ActionGroup | null,
	closeRoot: () => void,
) {
	const fullAction = attributeString(model, index, "action")
	const target = model.get_item_attribute_value(index, "target", null)
	const name = actionName(fullAction)
	const known = !!actionGroup && !!name && actionGroup.has_action(name)

	const button = new Gtk.Button()
	button.add_css_class("model-item")
	button.set_sensitive(!known || actionGroup!.get_action_enabled(name))

	const content = new Gtk.Box({ orientation: HORIZONTAL })
	if (known && isChecked(actionGroup!, name, target)) {
		const check = new Gtk.Image({ iconName: "object-select-symbolic", valign: CENTER })
		check.add_css_class("check")
		content.append(check)
	}
	content.append(new Gtk.Label({ label, useUnderline: true, xalign: 0, halign: START, hexpand: true }))
	button.set_child(content)

	button.connect("clicked", () => {
		if (known)
			actionGroup!.activate_action(name, target)
		closeRoot()
	})

	return button
}

function buildSubmenuButton(
	label: string,
	submodel: Gio.MenuModel,
	actionGroup: Gio.ActionGroup | null,
	closeRoot: () => void,
	register: (fn: () => void) => void,
) {
	const button = new Gtk.Button()
	button.add_css_class("model-item")
	button.add_css_class("submenu")

	const content = new Gtk.Box({ orientation: HORIZONTAL })
	content.append(new Gtk.Label({ label, useUnderline: true, xalign: 0, halign: START, hexpand: true }))
	content.append(new Gtk.Image({ iconName: "go-next-symbolic", valign: CENTER }))
	button.set_child(content)

	const { popover, revealer } = createAnimatedPopover(RIGHT)
	popover.set_parent(button)
	revealer.set_child(buildMenuBox(submodel, actionGroup, () => {
		popover.popdown()
		closeRoot()
	}, register))

	button.connect("clicked", () => popover.popup())
	register(() => popover.unparent())

	return button
}

function appendModel(
	box: Gtk.Box,
	model: Gio.MenuModel,
	actionGroup: Gio.ActionGroup | null,
	closeRoot: () => void,
	register: (fn: () => void) => void,
) {
	const count = model.get_n_items()
	for (let i = 0; i < count; i++) {
		const section = model.get_item_link(i, "section")
		if (section) {
			if (box.get_last_child())
				box.append(new Gtk.Separator())
			appendModel(box, section, actionGroup, closeRoot, register)
			continue
		}

		const label = attributeString(model, i, "label")
		const submenu = model.get_item_link(i, "submenu")
		if (submenu) {
			box.append(buildSubmenuButton(label, submenu, actionGroup, closeRoot, register))
			continue
		}

		box.append(buildItemButton(model, i, label, actionGroup, closeRoot))
	}
}

function buildMenuBox(
	model: Gio.MenuModel,
	actionGroup: Gio.ActionGroup | null,
	closeRoot: () => void,
	register: (fn: () => void) => void,
) {
	const box = new Gtk.Box({ orientation: VERTICAL })
	box.add_css_class("tray-menu")
	appendModel(box, model, actionGroup, closeRoot, register)
	return box
}

export function createTrayMenuPopover(item: AstalTray.TrayItem) {
	const { popover, revealer } = createAnimatedPopover(BOTTOM)

	let cleanups: Array<() => void> = []
	const register = (fn: () => void) => cleanups.push(fn)
	const runCleanups = () => {
		cleanups.forEach(fn => fn())
		cleanups = []
	}

	// BUG: Rebuilding eagerly on every items-changed crashed during monitor churn — a tray
	// app (e.g. Spotify) mutating its Gio.MenuModel mid-iteration left attributeString()
	// reading a freed GVariant. Build lazily, only right before the popover opens.
	let dirty = true
	const markDirty = () => { dirty = true }

	const rebuild = () => {
		runCleanups()
		const model = item.menuModel
		const content = model
			? buildMenuBox(model, item.actionGroup, () => popover.popdown(), register)
			: new Gtk.Box({ orientation: VERTICAL })
		revealer.set_child(content)
		dirty = false
	}

	const ensureBuilt = () => {
		if (dirty)
			rebuild()
	}

	let model: Gio.MenuModel | null = null
	let modelConn = 0
	const connectModel = () => {
		if (model && modelConn)
			model.disconnect(modelConn)

		model = item.menuModel
		modelConn = model ? model.connect("items-changed", markDirty) : 0
		markDirty()
	}

	connectModel()

	const itemConns = [
		item.connect("notify::menu-model", connectModel),
		item.connect("notify::action-group", markDirty),
	]

	onCleanup(() => {
		itemConns.forEach(id => item.disconnect(id))
		if (model && modelConn)
			model.disconnect(modelConn)
		runCleanups()
		popover.unparent()
	})

	return { popover, ensureBuilt }
}
