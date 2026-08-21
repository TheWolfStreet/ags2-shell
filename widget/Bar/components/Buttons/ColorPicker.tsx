// Shows a color picker button and a popup with recently picked colors.

import { createState, For } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { Gdk, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { idle } from "ags/time"

import Gio from "gi://Gio"

import env from "$lib/env"
import { ensureFile } from "$lib/files"
import icons from "$lib/icons"
import { attempt, attemptAsync } from "$lib/result"
import { debounce } from "$lib/time"
import { notify, notifyMissingPrograms } from "$service/notifications"
import { PanelButton } from "../PanelButton"
import { createAnimatedPopover } from "widget/shared/AnimatedPopover"
import options from "$shell/options"

const COLOR_HISTORY_FILE = `${env.paths.cache.base}/colors.json`

function wlCopy(data: string) {
	return new Promise<void>((resolve, reject) => {
		const process = Gio.Subprocess.new(
			["wl-copy"],
			Gio.SubprocessFlags.STDIN_PIPE,
		)
		process.communicate_utf8_async(data, null, (_, result) => {
			try {
				process.communicate_utf8_finish(result)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	})
}

function loadColorHistory() {
	const result = attempt(() => {
		const parsed: unknown = JSON.parse(readFile(COLOR_HISTORY_FILE) || "[]")
		if (!Array.isArray(parsed)) return []
		return parsed.filter((color) => typeof color === "string")
	})
	if (!result.ok) {
		console.error("colorpicker.load: Failed to load saved colors", result.err)
		return []
	}
	return result.value
}

ensureFile(COLOR_HISTORY_FILE)
const [colors, setColors] = createState(loadColorHistory())
let notificationId = 0
const saveColors = debounce(1000, async () => {
	const result = await attemptAsync(async () => {
		ensureFile(COLOR_HISTORY_FILE)
		await writeFileAsync(
			COLOR_HISTORY_FILE,
			JSON.stringify(colors.peek(), null, 0),
		)
	})
	if (!result.ok)
		console.error("colorpicker.save: Failed to save colors", result.err)
})

async function pickColor(existing?: string) {
	if (!existing && !notifyMissingPrograms("wl-copy", "hyprpicker")) return
	if (existing && !notifyMissingPrograms("wl-copy")) return

	let color = existing
	if (!color) {
		const result = await attemptAsync(async () =>
			execAsync(["hyprpicker", "-r"]),
		)
		if (!result.ok) return
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
		const nextColors = [...colors.peek()]
		if (!nextColors.includes(color)) {
			nextColors.push(color)
			if (nextColors.length > max) nextColors.shift()
			setColors(nextColors)
			saveColors.call()
		}
	}

	notify({
		id: notificationId,
		appName: "Colorpicker",
		appIcon: icons.ui.colorpicker,
		summary: "Copied to clipboard",
		body: color,
	}).then((id) => {
		if (id) notificationId = id
	})
}

export function ColorPicker() {
	const popover = createColorPopover()
	const tooltip = colors.as(
		(value) => `${value.length} color${value.length === 1 ? "" : "s"}`,
	)

	return (
		<PanelButton
			tooltipText={tooltip}
			onClicked={() => pickColor()}
			$={(self) => popover.set_parent(self)}
		>
			<Gtk.GestureClick
				button={Gdk.BUTTON_SECONDARY}
				onReleased={() => {
					if (colors.peek().length > 0) idle(() => popover.popup())
				}}
			/>
			<image iconName={icons.ui.colorpicker} useFallback />
		</PanelButton>
	)
}

function createColorCss() {
	const cache = new Map<string, string>()
	return (color: string) => {
		if (!cache.has(color))
			cache.set(
				color,
				`
			button { background-color: ${color}; color: transparent; box-shadow: inset 0 0 0 var(--border-width) var(--border-color), var(--neu-button-highlight), var(--neu-button-shadow); }
			button:hover { background-color: ${color}; color: white; text-shadow: 2px 2px 3px rgba(0,0,0,.8); box-shadow: inset 0 0 0 var(--border-width) var(--border-color), var(--neu-button-hover-highlight), var(--neu-button-hover-shadow); }
			button:active { background-color: ${color}; box-shadow: inset 0 0 0 var(--border-width) var(--border-color), var(--neu-button-active-highlight), var(--neu-button-active-shadow); }
		`,
			)
		return cache.get(color)!
	}
}

function createColorPopover() {
	const css = createColorCss()
	const { popover, revealer } = createAnimatedPopover(
		Gtk.PositionType.BOTTOM,
		false,
	)
	popover.set_focusable(false)
	revealer.set_focusable(false)
	revealer.set_child(
		(
			<box
				class="colorpicker vertical"
				orientation={Gtk.Orientation.VERTICAL}
				focusable={false}
			>
				<For each={colors}>
					{(color) => (
						<button
							label={color}
							css={css(color)}
							focusable={false}
							onClicked={() => {
								popover.get_root()?.set_focus(null)
								pickColor(color)
								popover.popdown()
							}}
						/>
					)}
				</For>
			</box>
		) as Gtk.Widget,
	)
	return popover
}
