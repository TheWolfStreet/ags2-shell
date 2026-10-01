import { createState, For, onCleanup } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { Gdk, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { idle } from "$lib/time"

import Gio from "gi://Gio"
import GLib from "gi://GLib"

import env from "$lib/env"
import { ensure_file } from "$lib/files"
import icons from "$lib/icons"
import { attempt, attempt_async, log_error, unwrap_or } from "$lib/result"
import { debounce } from "$lib/time"
import { notify, notify_missing_programs } from "$lib/notifications"
import { PanelButton } from "../PanelButton"
import { create_animated_popover } from "widget/shared/AnimatedPopover"
import options from "$shell/options"

const color_history_file = `${env.paths.cache.base}/colors.json`

function wl_copy(data: string) {
	return new Promise<void>((resolve, reject) => {
		const process = Gio.Subprocess.new(
			["wl-copy"],
			Gio.SubprocessFlags.STDIN_PIPE,
		)
		const cancellable = new Gio.Cancellable()
		let deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
			deadline = 0
			cancellable.cancel()
			process.force_exit()
			return GLib.SOURCE_REMOVE
		})
		process.communicate_utf8_async(data, cancellable, (_, result) => {
			if (deadline) GLib.Source.remove(deadline)
			try {
				process.communicate_utf8_finish(result)
				if (!process.get_successful()) throw new Error("wl-copy failed")
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	})
}

function color_limit() {
	return Math.max(0, Math.min(50, Math.floor(options.colorpicker.maxColors.peek())))
}

function load_color_history() {
	const result = attempt(() => {
		const file = Gio.File.new_for_path(color_history_file)
		if (!file.query_exists(null)) return []
		const info = file.query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null)
		if (info.get_size() > 64_000) throw new Error("Color history exceeds 64 KB")
		const parsed: unknown = JSON.parse(readFile(color_history_file) || "[]")
		if (!Array.isArray(parsed)) return []
		const valid = parsed.filter((color): color is string =>
			typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color),
		)
		const limit = color_limit()
		return limit ? valid.slice(-limit) : []
	})
	return unwrap_or(result, [], "colorpicker.load: Failed to load saved colors")
}

const [colors, set_colors] = createState(load_color_history())
let notification_id = 0
let pending_pick: Promise<void> = Promise.resolve()
let queued_picks = 0
let saving = false
let dirty = false
const save_colors = debounce(1000, async () => {
	if (saving) return
	saving = true
	try {
		while (dirty) {
			dirty = false
			const snapshot = JSON.stringify(colors.peek())
			const ready = ensure_file(color_history_file)
			const result = ready.ok ? await attempt_async(async () => {
				await writeFileAsync(color_history_file, snapshot)
			}) : ready
			if (!log_error(result, "colorpicker.save: Failed to save colors")) break
		}
	} finally {
		saving = false
		if (dirty) save_colors.call()
	}
})

function pick_color(existing?: string) {
	if (queued_picks >= 8) {
		console.warn("colorpicker.pick: Too many pending requests")
		return pending_pick
	}
	queued_picks++
	const next = pending_pick.then(() => run_pick(existing)).finally(() => { queued_picks-- })
	pending_pick = next.catch((error) => console.error("colorpicker.pick: Failed to pick color", error))
	return pending_pick
}

async function run_pick(existing?: string) {
	if (!existing && !notify_missing_programs("wl-copy", "hyprpicker")) return
	if (existing && !notify_missing_programs("wl-copy")) return

	let color = existing
	if (!color) {
		const result = await attempt_async(async () =>
			execAsync(["hyprpicker", "-r", "--format=hex"]),
		)
		if (!result.ok) return
		color = result.value.replace("[ERR] renderSurface: PBUFFER null", "").trim()
		if (!/^#[0-9a-fA-F]{6}$/.test(color)) return
	}

	const copied = await attempt_async(async () => wl_copy(color))
	if (!copied.ok) {
		console.error("colorpicker.copy: Failed to copy color", copied.err)
		return
	}

	if (!existing) {
		const limit = color_limit()
		const next_colors = limit
			? [...colors.peek().filter((value) => value !== color), color].slice(-limit)
			: []
		set_colors(next_colors)
		dirty = true
		save_colors.call()
	}

	const notified = await notify({
		id: notification_id,
		app_name: "Colorpicker",
		app_icon: icons.ui.colorpicker,
		summary: "Copied to clipboard",
		body: color,
	})
	if (notified.ok) notification_id = notified.value
	else console.error("colorpicker.notify: Failed to announce copied color", notified.err)
}

export function ColorPicker() {
	const popover = create_color_popover()
	let popup_timer: ReturnType<typeof idle> | null = null
	const update_position = () => popover.set_position(
		options.bar.position.peek() === "top-center" ? Gtk.PositionType.BOTTOM : Gtk.PositionType.TOP,
	)
	update_position()
	const position_unsubscribe = options.bar.position.subscribe(update_position)
	const limit_unsubscribe = options.colorpicker.maxColors.subscribe(() => {
		const limit = color_limit()
		if (colors.peek().length <= limit) return
		set_colors(limit ? colors.peek().slice(-limit) : [])
		dirty = true
		save_colors.call()
	})
	onCleanup(() => {
		position_unsubscribe()
		limit_unsubscribe()
		popup_timer?.cancel()
		popover.unparent()
	})
	const tooltip = colors.as(
		(value) => `${value.length} color${value.length === 1 ? "" : "s"}`,
	)

	return (
		<PanelButton
			tooltipText={tooltip}
			onClicked={() => { void pick_color() }}
			$={(self) => popover.set_parent(self)}
		>
			<Gtk.GestureClick
				button={Gdk.BUTTON_SECONDARY}
				onReleased={() => {
					if (colors.peek().length > 0) {
						popup_timer?.cancel()
						popup_timer = idle(() => {
							popup_timer = null
							popover.popup()
						})
					}
				}}
			/>
			<image iconName={icons.ui.colorpicker} useFallback />
		</PanelButton>
	)
}

function create_color_css(color: string) {
	return `
			button { background-color: ${color}; color: transparent; box-shadow: inset 0 0 0 var(--border-width) var(--border-color), var(--neu-button-highlight), var(--neu-button-shadow); }
			button:hover { background-color: ${color}; color: white; text-shadow: 2px 2px 3px rgba(0,0,0,.8); box-shadow: inset 0 0 0 var(--border-width) var(--border-color), var(--neu-button-hover-highlight), var(--neu-button-hover-shadow); }
			button:active { background-color: ${color}; box-shadow: inset 0 0 0 var(--border-width) var(--border-color), var(--neu-button-active-highlight), var(--neu-button-active-shadow); }
		`
}

function create_color_popover() {
	const { popover, revealer, dispose } = create_animated_popover(
		Gtk.PositionType.BOTTOM,
		false,
	)
	onCleanup(dispose)
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
							css={create_color_css(color)}
							focusable={false}
							onClicked={() => {
								popover.get_root()?.set_focus(null)
								void pick_color(color)
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
