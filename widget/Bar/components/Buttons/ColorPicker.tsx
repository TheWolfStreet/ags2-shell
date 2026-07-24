// Shows a color picker button and a popup with recently picked colors.

import { createBinding, For, type Accessor } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import GObject, { getter, register } from "ags/gobject"
import { Gdk, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { idle } from "ags/time"

import env from "$lib/env"
import { ensureFile } from "$lib/files"
import icons from "$lib/icons"
import { requirePrograms, wlCopy } from "$lib/programs"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/timing"
import { notify } from "$service/notifications"
import { PanelButton } from "../PanelButton"
import { AnimatedPopover, type AnimatedPopoverImpl } from "./TrayMenu"
import options from "options"

const COLOR_HISTORY_FILE = `${env.paths.cache.base}/colors.json`

function loadColorHistory() {
	const result = attempt(() => {
		const parsed: unknown = JSON.parse(readFile(COLOR_HISTORY_FILE) || "[]")
		if (!Array.isArray(parsed))
			return []
		return parsed.filter(color => typeof color === "string")
	})
	if (!result.ok) {
		console.error("colorpicker.load: Failed to load saved colors", result.err)
		return []
	}
	return result.value
}

@register()
class ColorPickerController extends GObject.Object {
	declare static $gtype: GObject.GType<ColorPickerController>
	static instance: ColorPickerController

	static get_default() {
		return this.instance ??= new ColorPickerController()
	}

	#notificationId = 0
	#colors: string[]
	#save = debounce(1000, async () => {
		const result = await attemptAsync(async () => {
			ensureFile(COLOR_HISTORY_FILE)
			await writeFileAsync(COLOR_HISTORY_FILE, JSON.stringify(this.#colors, null, 0))
		})
		if (!result.ok)
			console.error("colorpicker.save: Failed to save colors", result.err)
	})

	constructor() {
		super()
		ensureFile(COLOR_HISTORY_FILE)
		this.#colors = loadColorHistory()
	}

	@getter(Array)
	get colors() {
		return this.#colors
	}

	readonly pick = async (existing?: string) => {
		if (!existing && !requirePrograms("wl-copy", "hyprpicker")) return
		if (existing && !requirePrograms("wl-copy")) return

		let color = existing
		if (!color) {
			const result = await attemptAsync(async () => execAsync(["hyprpicker", "-r"]))
			if (!result.ok)
				return
			color = result.value.replace("[ERR] renderSurface: PBUFFER null", "").trim()
			if (!color) return
		}

		const copied = await attemptAsync(async () => wlCopy(color))
		if (!copied.ok) {
			console.error("colorpicker.copy: Failed to copy color", copied.err)
			return
		}

		if (!existing) {
			const max = options.colorpicker.maxColors.peek()
			const colors = [...this.#colors]
			if (!colors.includes(color)) {
				colors.push(color)
				if (colors.length > max) colors.shift()
				this.#colors = colors
				this.notify("colors")
				this.#save.call()
			}
		}

		notify({
			id: this.#notificationId,
			appName: "Colorpicker",
			appIcon: icons.ui.colorpicker,
			summary: "Copied to clipboard",
			body: color,
		}).then(id => {
			if (id) this.#notificationId = id
		})
	}

	vfunc_finalize() {
		this.#save.cancel()
		super.vfunc_finalize()
	}
}

const colorPicker = ColorPickerController.get_default()

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
