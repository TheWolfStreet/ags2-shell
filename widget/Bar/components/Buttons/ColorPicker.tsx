import { createState, For, onCleanup } from "ags"
import { readFile, writeFileAsync } from "ags/file"
import { Gdk, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { debounce, idle, type timer } from "$lib/time"

import Gio from "gi://Gio"

import env from "$lib/env"
import { ensure_file, file_size } from "$lib/files"
import { copy_to_clipboard } from "$lib/clipboard"
import icons from "$lib/icons"
import {
	attempt,
	attempt_async,
	err,
	log_error,
	ok,
	type result,
	unwrap_or,
} from "$lib/result"
import { notify, notify_missing_programs } from "$lib/notifications"
import { PanelButton } from "../PanelButton"
import {
	create_animated_popover,
	follow_bar_position,
} from "widget/shared/animated_popover"
import options from "$shell/options"

const color_history_file = `${env.paths.cache.base}/colors.json`
const hex_color = /^#[0-9a-fA-F]{6}$/
const max_pending_picks = 8

function keep_recent(list: string[]) {
	const limit = options.colorpicker.maxColors.peek()
	if (!limit) return []
	return list.slice(-limit)
}

function read_color_history(): result<string[]> {
	const file = Gio.File.new_for_path(color_history_file)
	if (!file.query_exists(null)) return ok([])

	const size = file_size(color_history_file)
	if (!size.ok) return size
	if (size.value > 64_000) return err(new Error("Color history exceeds 64 KB"))

	const parsed = attempt((): unknown =>
		JSON.parse(readFile(color_history_file) || "[]"),
	)
	if (!parsed.ok) return parsed
	if (!Array.isArray(parsed.value)) return ok([])

	const valid = parsed.value.filter(
		(color): color is string =>
			typeof color === "string" && hex_color.test(color),
	)
	return ok(keep_recent(valid))
}

const [colors, set_colors] = createState(
	unwrap_or(
		read_color_history(),
		[],
		"colorpicker.load: Failed to load saved colors",
	),
)
let notification_id = 0
let pending_pick: Promise<void> = Promise.resolve()
let queued_picks = 0
let saving = false
let dirty = false

async function write_color_history(snapshot: string): Promise<result<void>> {
	const ready = ensure_file(color_history_file)
	if (!ready.ok) return ready
	return attempt_async(async () => {
		await writeFileAsync(color_history_file, snapshot)
	})
}

async function flush_color_history() {
	while (dirty) {
		dirty = false
		const written = await write_color_history(JSON.stringify(colors.peek()))
		if (!log_error(written, "colorpicker.save: Failed to save colors")) return
	}
}

const save_colors = debounce(1000, async () => {
	if (saving) return
	saving = true
	try {
		await flush_color_history()
	} finally {
		saving = false
		if (dirty) save_colors.call()
	}
})

function store_colors(next: string[]) {
	set_colors(next)
	dirty = true
	save_colors.call()
}

function pick_color(existing?: string) {
	if (queued_picks >= max_pending_picks) {
		console.warn("colorpicker.pick: Too many pending requests")
		return
	}
	queued_picks++
	pending_pick = pending_pick.then(async () => {
		const picked = await attempt_async(() => run_pick(existing))
		queued_picks--
		log_error(picked, "colorpicker.pick: Failed to pick color")
	})
}

async function read_screen_color() {
	const picked = await attempt_async(() =>
		execAsync(["hyprpicker", "-r", "--format=hex"]),
	)
	if (!picked.ok) return null
	const color = picked.value
		.replace("[ERR] renderSurface: PBUFFER null", "")
		.trim()
	if (!hex_color.test(color)) return null
	return color
}

function required_programs(existing?: string) {
	if (existing) return ["wl-copy"]
	return ["wl-copy", "hyprpicker"]
}

async function run_pick(existing?: string) {
	if (!notify_missing_programs(...required_programs(existing))) return
	const color = existing || (await read_screen_color())
	if (!color) return

	const copied = await copy_to_clipboard(color)
	if (!log_error(copied, "colorpicker.copy: Failed to copy color")) return

	if (!existing)
		store_colors(
			keep_recent([...colors.peek().filter((value) => value !== color), color]),
		)

	const notified = await notify({
		id: notification_id,
		app_name: "Colorpicker",
		app_icon: icons.ui.colorpicker,
		summary: "Copied to clipboard",
		body: color,
	})
	const announced = log_error(
		notified,
		"colorpicker.notify: Failed to announce copied color",
	)
	if (announced) notification_id = notified.value
}

function trim_to_limit() {
	if (colors.peek().length <= options.colorpicker.maxColors.peek()) return
	store_colors(keep_recent(colors.peek()))
}

export function ColorPicker() {
	const popover = create_color_popover()
	let popup_timer: timer | null = null
	const stop_following = follow_bar_position(popover)
	const limit_unsubscribe =
		options.colorpicker.maxColors.subscribe(trim_to_limit)
	onCleanup(() => {
		stop_following()
		limit_unsubscribe()
		popup_timer?.cancel()
		popover.unparent()
	})

	function open_history() {
		if (colors.peek().length === 0) return
		popup_timer?.cancel()
		popup_timer = idle(() => {
			popup_timer = null
			popover.popup()
		})
	}

	return (
		<PanelButton
			tooltipText={colors.as(
				(value) => `${value.length} color${value.length === 1 ? "" : "s"}`,
			)}
			onClicked={() => pick_color()}
			$={(self) => popover.set_parent(self)}
		>
			<Gtk.GestureClick
				button={Gdk.BUTTON_SECONDARY}
				onReleased={open_history}
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
								pick_color(color)
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
