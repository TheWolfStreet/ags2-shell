// Shows a color picker button and a popup with recently picked colors.

import { createBinding, For, type Accessor } from "ags"
import { Gdk, Gtk } from "ags/gtk4"
import { idle } from "ags/time"

import icons from "$lib/icons"
import { colorPicker } from "$service/colorpicker"
import { PanelButton } from "../PanelButton"
import { AnimatedPopover, type AnimatedPopoverImpl } from "./TrayMenu"
import options from "options"

export function ColorPicker() {
	const colors = createBinding(colorPicker, "colors")
	const popover = createColorPopover(colors)
	const tooltip = colors.as(value => `${value.length} color${value.length === 1 ? "" : "s"}`)

	return (
		<PanelButton tooltipText={tooltip} onClicked={() => colorPicker.pick()} $={self => popover.set_parent(self)}>
			<Gtk.GestureClick
				button={Gdk.BUTTON_SECONDARY}
				onReleased={() => {
					if (colorPicker.colors.length > 0) idle(() => popover.popup())
				}}
			/>
			<image iconName={icons.ui.colorpicker} useFallback />
		</PanelButton>
	)
}

function createColorCss() {
	const cache = new Map<string, string>()
	return (color: string) => {
		if (!cache.has(color)) cache.set(color, `
			button { background-color: ${color}; color: transparent; box-shadow: inset 0 0 0 var(--border-width) var(--border-color), var(--neu-button-highlight), var(--neu-button-shadow); }
			button:hover { background-color: ${color}; color: white; text-shadow: 2px 2px 3px rgba(0,0,0,.8); box-shadow: inset 0 0 0 var(--border-width) var(--border-color), var(--neu-button-hover-highlight), var(--neu-button-hover-shadow); }
			button:active { background-color: ${color}; box-shadow: inset 0 0 0 var(--border-width) var(--border-color), var(--neu-button-active-highlight), var(--neu-button-active-shadow); }
		`)
		return cache.get(color)!
	}
}

function createColorPopover(colors: Accessor<string[]>) {
	const css = createColorCss()
	const popover = new AnimatedPopover() as AnimatedPopoverImpl
	popover.set_has_arrow(false)
	popover.set_position(Gtk.PositionType.BOTTOM)
	popover.set_focusable(false)
	popover.set_child(
		<revealer
			$={self => { popover.revealer = self }}
			focusable={false}
			transitionDuration={options.transition.duration}
			transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
			onNotifyChildRevealed={self => {
				if (!self.get_child_revealed() && !self.get_reveal_child()) popover.performHide()
			}}
		>
			<box class="colorpicker vertical" orientation={Gtk.Orientation.VERTICAL} focusable={false}>
				<For each={colors}>
					{color => (
						<button
							label={color}
							css={css(color)}
							focusable={false}
							onClicked={() => {
								popover.get_root()?.set_focus(null)
								colorPicker.pick(color)
								popover.popdown()
							}}
						/>
					)}
				</For>
			</box>
		</revealer> as Gtk.Revealer,
	)
	return popover
}
